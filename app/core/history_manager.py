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
    功能：
    1. 从 raw_content 中提取 "【参考文件：xxx】" 的文件名。
    2. 清洗掉 RAG 提示词上下文，只保留用户的真实问题。
    
    返回: (cleaned_text, file_list)
    """
    if not isinstance(content, str):
        return "", []

    files = []
    
    # ---------------------------------------------------------
    # 1. 提取文件名 (修改点：适配新的 Prompt 格式)
    # ---------------------------------------------------------
    
    # 针对你提供的样本：【参考文件：周计划.xlsx】
    # 正则解释：
    # \[ 和 \] 匹配中括号
    # (.*?) 是非贪婪匹配，提取文件名
    matches = re.findall(r"【参考文件：(.*?)】", content)
    
    for name in matches:
        # 由于现在统一叫“参考文件”，我们需要根据后缀名判断是否为图片
        # 这样前端才能显示正确的图标 (ImageIcon 或 FileText)
        ext = name.split('.')[-1].lower() if '.' in name else ""
        
        if ext in ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']:
            file_type = "image"
        else:
            file_type = "file"
            
        files.append({"name": name, "type": file_type})

    # --- 兼容旧格式 (可选，为了防止有旧数据的遗留) ---
    # 如果你的系统里还有 "用户上传了图片 xxx" 这种旧格式，可以保留下面这段
    old_img_matches = re.findall(r"用户上传了图片 (.*?)，", content)
    for name in old_img_matches:
        files.append({"name": name, "type": "image"})

    # ---------------------------------------------------------
    # 2. 清洗文本
    # ---------------------------------------------------------
    cleaned_text = content
    marker = "用户的具体问题是："
    
    if marker in content:
        # 截取 marker 之后的内容
        cleaned_text = content.split(marker)[-1].strip()
    else:
        # 如果没有找到 marker，但确实检测到了文件
        # 说明这可能是一条纯文件发送的消息（没有附带文字问题）
        # 或者 Prompt 格式不完整。
        if files:
            # 策略：如果全是文件上下文且没有 marker，则认为用户没有输入文本
            # 我们可以尝试过滤掉 prompt 的头部，或者直接返回空字符串让前端只显示文件
            # 这里简单处理：如果包含 "【参考文件：" 但没找到 marker，为了不显示一大堆乱码，
            # 我们尽量返回空，或者只返回 marker 之前的一小段（但这很难判断）。
            # 最稳妥的方式：如果全是 Context 且没 marker，就设为空。
            if "用户上传了以下参考资料" in content:
                cleaned_text = "" 
            pass

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