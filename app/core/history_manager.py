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
IMAGES_DIR = "./factory_images"
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

def read_image_as_base64(image_path):
    """辅助函数：安全读取图片并转为 Base64"""
    if not os.path.exists(image_path):
        return None
    try:
        with open(image_path, "rb") as f:
            b64_str = base64.b64encode(f.read()).decode('utf-8')
            ext = image_path.split('.')[-1].lower()
            return f"data:image/{ext};base64,{b64_str}"
    except Exception as e:
        print(f"Error reading image {image_path}: {e}")
        return None

def clean_text_markers(content: str):
    """
    仅负责清洗文本中的【参考文件】标记，不提取文件。
    用于当我们在其他地方已经提取了文件时（例如从 image_url）。
    """
    if not isinstance(content, str): return content
    # 去除新格式
    content = re.sub(r"【参考文件:.*?\|路径:.*?】", "", content)
    # 去除旧格式
    content = re.sub(r"【参考文件:.*?】", "", content)
    # 去除提示词
    if "用户上传了以下参考资料:" in content:
        content = content.replace("用户上传了以下参考资料:", "")
    return content.strip()

def parse_files_from_text_only(content: str):
    """
    仅当 content 是纯字符串时使用的后备方案（兼容旧历史记录）。
    """
    files = []
    cleaned_text = content
    
    # 1. 提取带路径的新格式
    matches_with_path = re.findall(r"【参考文件:(.*?)\|路径:(.*?)】", content)
    for original_name, saved_path in matches_with_path:
        # 清洗文本
        cleaned_text = cleaned_text.replace(f"【参考文件:{original_name}|路径:{saved_path}】", "")
        
        ext = saved_path.split('.')[-1].lower()
        full_path = os.path.join(IMAGES_DIR, saved_path)
        
        if ext in ['jpg', 'jpeg', 'png', 'webp']:
            b64 = read_image_as_base64(full_path)
            if b64:
                files.append({"name": original_name, "type": "image/png", "content": b64})
        else:
            files.append({"name": original_name, "type": "file"})

    # 2. 提取旧格式 (避免重复)
    old_matches = re.findall(r"【参考文件:(.*?)】", cleaned_text)
    for name in old_matches:
        cleaned_text = cleaned_text.replace(f"【参考文件:{name}】", "")
        # 如果前面已经加过了，跳过
        if any(f['name'] == name for f in files): 
            continue
        files.append({"name": name, "type": "file"}) # 旧格式无法读取图片内容，只当文件

    # 3. 清洗提示词
    marker = "用户的具体问题是:"
    if marker in cleaned_text:
        cleaned_text = cleaned_text.split(marker)[-1]
    
    return cleaned_text.strip(), files

async def get_history(thread_id: str):
    """
    核心逻辑：优先解析 List 类型的多模态消息，避免正则重复解析
    """
    graph = await get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    state_snapshot = await graph.aget_state(config)
    
    if not state_snapshot.values:
        return []
    
    messages = state_snapshot.values.get("messages", [])
    formatted_history = []

    for msg in messages:
        if isinstance(msg, HumanMessage):
            role = "user"
        elif isinstance(msg, AIMessage):
            role = "ai"
        else:
            continue

        raw_content = msg.content
        if not raw_content: continue

        final_content = ""
        attached_files = []

        # =================================================
        # 情况 A: 内容是列表 (Multimodal - 包含图片)
        # =================================================
        if isinstance(raw_content, list):
            has_image_url = False
            temp_text_parts = []

            for item in raw_content:
                if isinstance(item, dict):
                    # --- 提取图片 (最高优先级) ---
                    if item.get("type") == "image_url":
                        has_image_url = True
                        img_data = item.get("image_url", {})
                        url_str = img_data.get("url") if isinstance(img_data, dict) else img_data
                        
                        if url_str:
                            # 确保 base64 前缀存在
                            if not url_str.startswith("data:") and not url_str.startswith("http"):
                                url_str = f"data:image/png;base64,{url_str}"
                                
                            attached_files.append({
                                "name": "image.png", 
                                "type": "image/png", 
                                "content": url_str
                            })
                    
                    # --- 提取文本 ---
                    elif item.get("type") == "text":
                        temp_text_parts.append(item.get("text", ""))
            
            # 合并文本
            full_text = " ".join(temp_text_parts)
            
            # 关键逻辑：如果我们已经通过 image_url 拿到了图片，
            # 那么文本里的【参考文件】标记就是重复的垃圾信息，直接清洗掉，不要再解析文件了
            if has_image_url:
                final_content = clean_text_markers(full_text)
            else:
                # 如果列表里只有文本(没图片)，才尝试从文本正则提取文件
                final_content, text_files = parse_files_from_text_only(full_text)
                attached_files.extend(text_files)

        # =================================================
        # 情况 B: 内容是纯字符串 (Legacy / 纯文本)
        # =================================================
        elif isinstance(raw_content, str):
            final_content, attached_files = parse_files_from_text_only(raw_content)

        # 最终清洗：如果只剩下空文本（被清洗掉了）但有文件，就不显示文本
        if not final_content and attached_files:
             # 有时候清洗后会留下一堆换行符
             final_content = ""

        formatted_history.append({
            "role": role,
            "content": final_content,
            "files": attached_files
        })

    return formatted_history