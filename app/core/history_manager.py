import os
import sys
import nest_asyncio
nest_asyncio.apply()

import warnings
import logging
import asyncio
import torch
import re
import json
import datetime
import base64
import uuid

warnings.filterwarnings("ignore")

from typing import Annotated, Literal, TypedDict
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage, AIMessage
from typing import TypedDict, Annotated, Sequence
from psycopg_pool import AsyncConnectionPool
from contextlib import asynccontextmanager
from passlib.context import CryptContext
from app.core.agent import chat_stream, pool, get_graph
# 配置密码哈希算法
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 初始化数据库
async def init_database():
    """
    系统启动时运行：创建所有必要的表结构，并初始化管理员
    """
    print("🛠️ [Database] 正在检查并初始化表结构...")
    
    async with pool.connection() as conn:
        await conn.set_autocommit(True)
        async with conn.cursor() as cur:
            # --- 1. LangGraph 核心表 ---
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS checkpoints (
                    thread_id TEXT NOT NULL,
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL,
                    parent_checkpoint_id TEXT,
                    type TEXT,
                    checkpoint JSONB NOT NULL,
                    metadata JSONB NOT NULL DEFAULT '{}',
                    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
                );
            """)
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS checkpoint_blobs (
                    thread_id TEXT NOT NULL,
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    channel TEXT NOT NULL,
                    version TEXT NOT NULL,
                    type TEXT NOT NULL,
                    blob BYTEA,
                    PRIMARY KEY (thread_id, checkpoint_ns, channel, version)
                );
            """)
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS checkpoint_writes (
                    thread_id TEXT NOT NULL,
                    checkpoint_ns TEXT NOT NULL DEFAULT '',
                    checkpoint_id TEXT NOT NULL,
                    task_id TEXT NOT NULL,
                    idx INTEGER NOT NULL,
                    channel TEXT NOT NULL,
                    type TEXT,
                    blob BYTEA,
                    value JSONB,
                    task_path TEXT NOT NULL DEFAULT '', 
                    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
                );
            """)

            # --- 2. 用户体系表 ---
            # 用户表
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS users (
                    user_id TEXT PRIMARY KEY,
                    username TEXT UNIQUE NOT NULL,
                    password_hash TEXT NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)
            
            # 用户-会话 关联表
            await cur.execute("""
                CREATE TABLE IF NOT EXISTS user_threads (
                    thread_id TEXT PRIMARY KEY,
                    user_id TEXT REFERENCES users(user_id),
                    title TEXT,
                    thread_type TEXT DEFAULT 'training', 
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            # 为了兼容旧数据，尝试添加字段（如果表已存在但没这个字段）
            try:
                await cur.execute("ALTER TABLE user_threads ADD COLUMN IF NOT EXISTS thread_type TEXT DEFAULT 'training';")
            except Exception as e:
                print(f"⚠️ 字段添加跳过 (可能已存在): {e}")

            print("✅ [Database] 表结构验证通过！")

    # --- 3. 初始化默认管理员账号 ---
    # 这个函数在之前定义过，确保它被调用
    await init_default_user()

# 初始化管理员账号
async def init_default_user():
    """初始化一个默认管理员账号，防止没法登录"""
    default_user = "admin"
    default_pass = "admin123" # 默认密码
    
    user_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, default_user))
    # 加密密码
    hashed_pw = pwd_context.hash(default_pass)
    
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 如果不存在才插入
            await cur.execute("""
                INSERT INTO users (user_id, username, password_hash) 
                VALUES (%s, %s, %s) 
                ON CONFLICT (username) DO NOTHING
            """, (user_id, default_user, hashed_pw))
            print(f"👤 [System] 默认管理员已就绪: 用户名={default_user}, 密码={default_pass}")

# 1. 用户登录 (带密码验证)
async def db_login_user(username: str, password: str):
    """验证用户名和密码"""
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 查出该用户的 ID 和 哈希密码
            await cur.execute("SELECT user_id, password_hash FROM users WHERE username = %s", (username,))
            row = await cur.fetchone()
            
            if not row:
                return {"error": "用户不存在"}
            
            user_id, stored_hash = row
            
            # 验证密码
            if not pwd_context.verify(password, stored_hash):
                return {"error": "密码错误"}
            
            return {"user_id": user_id, "username": username}

# 2. 获取用户的历史会话列表
# 增加 thread_type 参数，默认为 'training'
async def db_get_user_threads(user_id: str, thread_type: str = "training"):
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # SQL 语句中增加 WHERE thread_type = %s
            await cur.execute("""
                SELECT thread_id, title, updated_at 
                FROM user_threads 
                WHERE user_id = %s AND thread_type = %s
                ORDER BY updated_at DESC
            """, (user_id, thread_type))
            rows = await cur.fetchall()
            return [
                {
                    "id": row[0], 
                    "title": row[1] if row[1] else "新会话", 
                    "date": row[2].strftime("%Y-%m-%d %H:%M") if row[2] else ""
                } 
                for row in rows
            ]

# 3. 创建新会话
async def db_create_thread(user_id: str, title: str = "新会话", thread_type: str = "training"):
    thread_id = str(uuid.uuid4())
    print(f"DEBUG: Creating thread - User: {user_id}, Title: {title}, Type: {thread_type}") # 添加打印以便调试
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 插入 thread_type
            await cur.execute("""
                INSERT INTO user_threads (thread_id, user_id, title, thread_type)
                VALUES (%s, %s, %s, %s)
            """, (thread_id, user_id, title, thread_type))
    return {"id": thread_id, "title": title, "messages": []}

# 4. 更新会话时间
async def db_update_thread_timestamp(thread_id: str):
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                UPDATE user_threads SET updated_at = CURRENT_TIMESTAMP WHERE thread_id = %s
            """, (thread_id,))

# 5. 直接更新会话标题的数据库函数
async def db_update_thread_title(thread_id: str, title: str):
    """
    更新指定会话的标题
    """
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                UPDATE user_threads 
                SET title = %s, updated_at = CURRENT_TIMESTAMP 
                WHERE thread_id = %s
            """, (title, thread_id))

# 6.删除会话及其历史记录
async def db_delete_thread(thread_id: str, user_id: str):
    """
    删除指定的会话，包括元数据和 LangGraph 的历史记录
    """
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            # 1. 删除用户会话记录 (确保只能删除属于该用户的会话)
            #返回被删除的行数，用于判断是否存在或是否有权删除
            await cur.execute("""
                DELETE FROM user_threads 
                WHERE thread_id = %s AND user_id = %s
            """, (thread_id, user_id))
            
            if cur.rowcount == 0:
                return False # 删除失败（未找到或无权删除）

            # 2. 清理 LangGraph 产生的历史数据 (checkpoints 表等)
            # 这些表里 thread_id 是主键的一部分
            await cur.execute("DELETE FROM checkpoints WHERE thread_id = %s", (thread_id,))
            await cur.execute("DELETE FROM checkpoint_blobs WHERE thread_id = %s", (thread_id,))
            await cur.execute("DELETE FROM checkpoint_writes WHERE thread_id = %s", (thread_id,))
            
            return True

# 7.获取先前历史记录的函数，供前端展示
def parse_files_and_clean_content(content: str):
    """
    功能:
    1. 从 raw_content 中提取 "【参考文件:xxx|路径:yyy】" 的文件名和路径。
    2. 清洗掉 RAG 提示词上下文,只保留用户的真实问题。
    3. 🟢 新增: 如果是图片,读取文件返回 base64
    
    返回: (cleaned_text, file_list)
    """
    if not isinstance(content, str):
        return "", []

    files = []
    
    # ---------------------------------------------------------
    # 1. 提取文件名和路径 (新格式: 【参考文件:原名|路径:保存名】)
    # ---------------------------------------------------------
    
    # 正则匹配新格式
    matches_with_path = re.findall(r"【参考文件:(.*?)\|路径:(.*?)】", content)
    
    for original_name, saved_path in matches_with_path:
        ext = original_name.split('.')[-1].lower() if '.' in original_name else ""
        
        if ext in ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']:
            file_type = "image"
            base64_data = None
            
            # 🟢 读取图片文件
            img_path = os.path.join(IMAGES_DIR, saved_path)
            if os.path.exists(img_path):
                try:
                    with open(img_path, "rb") as f:
                        base64_data = base64.b64encode(f.read()).decode('utf-8')
                except Exception as e:
                    print(f"⚠️ 读取图片失败: {img_path}, 错误: {e}")
            else:
                print(f"⚠️ 图片文件不存在: {img_path}")
            
            files.append({
                "name": original_name,
                "type": file_type,
                "base64": base64_data  
            })
        else:
            files.append({
                "name": original_name,
                "type": "file"
            })
    
    # ---------------------------------------------------------
    # 兼容旧格式 (没有路径信息的)
    # ---------------------------------------------------------
    old_matches = re.findall(r"【参考文件:(.*?)】", content)
    for name in old_matches:
        # 跳过已经处理过的(新格式的)
        if any(f["name"] == name for f in files):
            continue
            
        ext = name.split('.')[-1].lower() if '.' in name else ""
        if ext in ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']:
            # 旧数据,只能返回文件名,无法加载base64
            files.append({"name": name, "type": "image", "base64": None})
        else:
            files.append({"name": name, "type": "file"})

    # ---------------------------------------------------------
    # 2. 清洗文本
    # ---------------------------------------------------------
    cleaned_text = content
    marker = "用户的具体问题是:"
    
    if marker in content:
        cleaned_text = content.split(marker)[-1].strip()
    else:
        if files:
            if "用户上传了以下参考资料" in content:
                cleaned_text = "" 

    return cleaned_text.strip(), files


async def get_history(thread_id: str):
    """
    从 PostgreSQL 读取历史，并解析出文件信息
    """
    # 1. 获取 Graph 状态
    graph = await get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    state_snapshot = await graph.aget_state(config)
    
    if not state_snapshot.values:
        return []
    
    messages = state_snapshot.values.get("messages", [])
    
    formatted_history = []
    for msg in messages:
        # 确定角色
        if isinstance(msg, HumanMessage):
            role = "user"
        elif isinstance(msg, AIMessage):
            role = "ai"
        else:
            continue

        raw_content = msg.content
        
        # 过滤空消息
        if not raw_content:
            continue
        
        # 处理内容
        final_content = raw_content
        attached_files = []

        print(raw_content)
        if role == "user":
            # 调用新的解析函数
            final_content, attached_files = parse_files_and_clean_content(raw_content)

        formatted_history.append({
            "role": role,
            "content": final_content,
            "files": attached_files # 新增字段：文件列表
        })
        
    return formatted_history