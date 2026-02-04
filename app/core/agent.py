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
# os.environ["TRANSFORMERS_VERBOSITY"] = "error"  # 只显示严重错误
# os.environ["HF_HUB_DISABLE_SYMLINKS_WARNING"] = "1" # 屏蔽 Windows 下的符号链接警告
# logging.getLogger("langchain").setLevel(logging.ERROR)
# logging.getLogger("langgraph").setLevel(logging.ERROR)

from typing import Annotated, Literal, TypedDict

# --- LlamaIndex 依赖 (用于 RAG) ---
from llama_index.core import VectorStoreIndex, Settings
from llama_index.vector_stores.elasticsearch import ElasticsearchStore
from llama_index.embeddings.huggingface import HuggingFaceEmbedding
from llama_index.postprocessor.flag_embedding_reranker import FlagEmbeddingReranker
from llama_index.llms.openai_like import OpenAILike

# --- LangGraph & LangChain 依赖 (用于 Agent) ---
from langgraph.graph import StateGraph
from langchain_openai import ChatOpenAI
from langchain_core.tools import tool
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, ToolMessage, AIMessage
from langgraph.checkpoint.memory import MemorySaver
from typing import TypedDict, Annotated, Sequence
from langgraph.graph import add_messages
from langgraph.prebuilt import ToolNode
from langgraph.checkpoint.postgres.aio import AsyncPostgresSaver
from psycopg_pool import AsyncConnectionPool
from contextlib import asynccontextmanager
from passlib.context import CryptContext
# 配置密码哈希算法
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# 加载环境变量
from dotenv import load_dotenv
load_dotenv(override=True)
# 定义待解答问题的文件路径
UNANSWERED_FILE = "unanswered_questions.json"
# 定义本地图片存储路径
IMAGES_DIR = "./factory_images"

es_url = "http://localhost:9200"
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")
DB_URI = os.getenv("DB_URI", "postgresql://admin:factory_pass@localhost:5432/factory_agent")

# 创建连接池（添加更多配置参数）
pool = AsyncConnectionPool(
    conninfo=DB_URI,
    min_size=1,          # 最小连接数
    max_size=10,         # 最大连接数（降低以避免资源占用）
    open=False,          # 延迟打开
    timeout=10,          # 连接超时时间（秒）
    max_waiting=0,       # 不排队等待连接
    max_lifetime=3600,   # 连接最大生命周期（1小时）
    max_idle=600,        # 空闲连接最大时间（10分钟）
    kwargs={"autocommit": True} # 建议开启 autocommit
)

checkpointer = AsyncPostgresSaver(pool)

# ==============================================================================
# 1. 准备 RAG 引擎
# ==============================================================================

# 配置 Embedding
GLOBAL_EMBED_MODEL = HuggingFaceEmbedding(model_name="models/hub/models--BAAI--bge-m3")

Settings.embed_model = GLOBAL_EMBED_MODEL

Settings.llm = None

# 配置 Reranker (核心竞争力: 重排序)
reranker = FlagEmbeddingReranker(
    model="models/hub/models--BAAI--bge-reranker-base", 
    top_n=5,
    use_fp16=True  # 必须开启半精度，进一步省显存
)

# ==============================================================================
# 2. 定义 Agent 的工具 (Tool)
# ==============================================================================

@tool
def search_factory_knowledge(query: str) -> str:
    """
    当用户询问工厂设备故障、错误码、维修步骤或操作规程时，必须调用此工具进行查询。
    重要提示:query 参数必须是完整的中文问题句子，不要随意对用户的问题进行概括、不要提取关键词。
    :param query: 必要参数，字符串类型，用于输入用户的具体问题。
    :return: 返回查询的结果和来源文件，包含图文混排内容。
    """
    print(f"\n🔍 [Agent 动作] 正在调用知识库查询: {query}")
    vector_store = None
    try:
        # 连接 ES 数据库
        vector_store = ElasticsearchStore(
            es_url=es_url,
            index_name="factory_knowledge",
        )
        index = VectorStoreIndex.from_vector_store(vector_store=vector_store)

        # RAG Engine
        rag_engine = index.as_query_engine(
            similarity_top_k=10,  # 粗排
            node_postprocessors=[reranker], # 精排
            verbose=True,
            response_mode="no_text"
        )
        # 调用 LlamaIndex 的 RAG 引擎
        response = rag_engine.query(query)

        # ---------------------------------------------------------
        # 1. 排序：先按文件名，再按页码
        # ---------------------------------------------------------
        node_data = []
        if hasattr(response, 'source_nodes'):
            for node in response.source_nodes:
                page_str = node.metadata.get('page_label', '0')
                try:
                    page_num = int(page_str)
                except ValueError:
                    page_num = 0
                
                node_data.append({
                    "text": node.text,
                    "file_name": node.metadata.get('file_name', '未知文件'),
                    "page_label": page_num
                })

        sorted_nodes = sorted(node_data, key=lambda x: (x['file_name'], x['page_label']))

        # ---------------------------------------------------------
        # 2. 拼接：构建连续的上下文流
        # ---------------------------------------------------------
        final_context_list = []
        current_file = None
        
        for item in sorted_nodes:
            # 如果换文件了，加一个明显的大标题
            if item['file_name'] != current_file:
                final_context_list.append(f"\n\n====== 文件: {item['file_name']} (开始) ======\n")
                current_file = item['file_name']
            
            # 使用更紧凑的分页标记，并在标记中提示 LLM 注意跨页连接
            # 我们故意在分页符前后少加换行，让 LLM 感觉这是一篇连续的文章
            context_str = f"\n{item['text']}"
            final_context_list.append(context_str)

        final_response = "".join(final_context_list) # 使用空字符串连接，更紧凑
        
        if not final_response.strip():
            return "未在知识库中找到相关内容。"

        # Debug
        print("✅ [Debug] 已按页码重排检索结果")
        print("内容预览：", final_response) # 调试时可开启
        
        return final_response
    except Exception as e:
        print(f"❌ 详细错误: {type(e).__name__}: {e}")
        import traceback
        traceback.print_exc()
        return f"查询出错: {e}"
    
    finally:
        # 显式关闭 Elasticsearch 客户端连接
        if vector_store is not None:
            try:
                # 关闭 ES 客户端
                if hasattr(vector_store, 'client'):
                    asyncio.get_event_loop().run_until_complete(
                        vector_store.client.close()
                    )
            except Exception as e:
                pass  # 忽略关闭时的错误

@tool
def record_missing_knowledge(user_query: str, reason: str = "未检索到相关文档") -> str:
    """
    当 'search_factory_knowledge' 工具无法在知识库中找到答案，或者检索到的内容与用户问题不匹配时，
    **必须**调用此工具将问题记录到待解答库中。
    :param user_query: 用户的原始问题。
    :param reason: 记录原因（例如：知识库无结果、结果不相关）。
    :return: 返回记录成功的提示。
    """
    print(f"\n📝 [Agent 动作] 正在记录缺失知识: {user_query}")

    # 读取旧数据
    data = []
    if os.path.exists(UNANSWERED_FILE):
        try:
            with open(UNANSWERED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except:
            data = []
    
    # 去重逻辑：检查是否已存在相同的 query
    for item in data:
        # 使用 strip() 去除首尾空格，确保匹配准确
        if item.get("query", "").strip() == user_query.strip():
            print(f"⚠️ [Agent 动作] 发现待解答库中已存在该问题，跳过写入: {user_query}")
            return "该问题已成功记录到待解答问题库，请告知用户工程师将后续补充此知识。"
        
    # 构造记录数据
    record = {
        "timestamp": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "query": user_query,
        "reason": reason,
        "status": "pending" # pending=待人工处理, solved=已入库
    }

    # 读取旧数据并追加
    data = []
    if os.path.exists(UNANSWERED_FILE):
        try:
            with open(UNANSWERED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
        except:
            data = []
    
    data.append(record)

    # 写入文件
    with open(UNANSWERED_FILE, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    return "该问题已成功记录到待解答问题库，请告知用户工程师将后续补充此知识。"

# 工具列表
tools = [search_factory_knowledge, record_missing_knowledge]

# ==============================================================================
# 多模态处理核心函数
# ==============================================================================
def convert_to_multimodal_messages(messages):
    """
    这是一个中间件函数。
    它的作用是：检查最近一条消息（通常是 ToolMessage），
    如果有 Markdown 图片链接，就把它变成 Base64 发给大模型。
    """
    processed_messages = list(messages)
    last_msg = processed_messages[-1]

    if isinstance(last_msg, ToolMessage) and "![示意图]" in str(last_msg.content):
        text_content = last_msg.content
        new_content_blocks = []
        
        # 正则匹配 Markdown 图片链接
        pattern = rf'!\[.*?\]\(({re.escape(API_BASE_URL)}/images/(.*?))\)'
        last_end = 0
        for match in re.finditer(pattern, text_content):
            start, end = match.span()
            
            # 添加图片前的文字
            if start > last_end:
                text_part = text_content[last_end:start]
                if text_part:
                    new_content_blocks.append({"type": "text", "text": text_part})
            
            img_url = match.group(1)
            filename = match.group(2)
            local_path = os.path.join(IMAGES_DIR, filename)
            
            if os.path.exists(local_path):
                try:
                    # [过滤] 忽略小于 1.5KB 的图标/噪点
                    if os.path.getsize(local_path) < 1500:
                        print(f"⚠️ [中间件] 忽略微型图片: {filename}")
                    else:
                        with open(local_path, "rb") as f:
                            b64_data = base64.b64encode(f.read()).decode("utf-8")
                        
                        new_content_blocks.append({
                            "type": "text", 
                            "text": f"\n[系统提示：图片引用链接 {img_url}]\n"
                        })
                        new_content_blocks.append({
                            "type": "image_url",
                            "image_url": {"url": f"data:image/jpeg;base64,{b64_data}"}
                        })
                except Exception as e:
                    print(f"❌ 图片处理异常: {e}")
            
            last_end = end
            
        # 添加剩余文字
        if last_end < len(text_content):
            tail = text_content[last_end:]
            if tail:
                new_content_blocks.append({"type": "text", "text": tail})
                
        last_msg.content = new_content_blocks
        
    return processed_messages

# ==============================================================================
# 3. 构建Agent
# ==============================================================================
llm = ChatOpenAI(
    model="qwen3-vl-plus", 
    openai_api_key=os.getenv('DASHSCOPE_API_KEY'),
    openai_api_base="https://dashscope.aliyuncs.com/compatible-mode/v1",
    temperature=0.1,
    max_tokens=2048,
    model_kwargs={"stream": True} 
)

system_prompt = SystemMessage(content="""
    ### 角色定义
    你是一个严谨专业的工厂智能助手。你的任务是根据知识库的内容，回答用户的故障处理或操作问题。
    **你拥有视觉能力**，可以阅读查询结果中的图片内容。

    ### 反死循环协议 (最高优先级)
    1. **单次搜索原则**：针对用户的同一个问题，你**最多只能调用三次** `search_factory_knowledge` 工具。
    2. **禁止重试**：如果三次搜索返回的内容都无法支撑你回答用户的问题，**严禁**再次调用搜索工具。
    3. **立即记录**：发现检索内容不足以回答问题，**必须立即**调用 `record_missing_knowledge`，绝对不要犹豫或尝试自我纠正。
                              
    ### 核心工作流 (必须严格执行以下步骤)
    **第1步：提取关键实体**
    - 分析用户问题，提取核心设备/系统名称（例如：“自动分拣系统”、“FANUC机器人”、“传送带”）。
    - 记住这个核心实体，它是本次回答的“主语”。

    **第2步：查询并审查 (关键一步)**
    - 调用 `search_factory_knowledge` 查询知识库。
    - **审查查询结果的主语**：
      - 仔细阅读查询到的每一段文字，寻找其中提到的设备名称。
      - **匹配检查示例**：
        - 用户问：“自动分拣系统” -> 查询内容：“机器人手动操作...” -> **不匹配！** (这是张冠李戴)
        - 用户问：“自动分拣系统” -> 查询内容：“分拣单元操作...” -> **匹配。**
        - 用户问：“自动分拣系统” -> 查询内容完全没提设备名，只说“按下红色按钮” -> **高风险！** 除非你能从上下文（如文件名）确信这是分拣系统，否则视为不匹配。
    - **审查图片内容 (视觉能力)**：
      - 你会看到穿插在文字中的图片。
      - **请仔细看图**：判断图片内容是“设备操作示意图/电路图/实物图”还是“无意义的Logo/页眉”。
      - **决策**：只有当图片能辅助说明操作步骤时，才保留它；如果是无关图片，请直接忽略，不要输出。
                              
    **第3步：决策与行动**
    - **情况 A (主语匹配 且 内容相关)**：
      - 对查询的结果进行整合或提取，清晰准确地回答用户。
      - **图文混排规则**：
        - 你的回答必须图文并茂。
        - 引用图片时，请使用 Markdown 格式：`![示意图](图片链接)`。
        - **注意**：只能使用系统提示中给出的 `http://localhost...` 链接，**绝对不要**输出 Base64 编码。
    - **情况 B (主语不匹配 或 查询工具返回“未在知识库中找到相关内容” 或 返回的内容与用户问题的关联性很低，不足以支撑你回答用户的问题)**：
      - **绝对禁止**强行拼凑答案。例如：不要把机器人的操作安在分拣系统头上。
      - **必须**调用 `record_missing_knowledge` 工具，将问题记录到待解答库。
      - 礼貌回复用户：“抱歉，当前知识库中暂未收录此问题。但我已将其自动记录到【待解答问题库】，工程师将在后续更新中补充该内容。”
                              
    ### 注意事项
    1. **完整性**：你输出的内容务必能够**完整**地契合用户的问题，例如用户提问“自动分拣系统的手动操作流程”，查询工具返回的内容只包含“手动操作流程”，但缺少“自动分拣系统”这个关键词，也要视为无法回答用户问题，需要将该问题存入待解答问题库。
    2. **图文对应**：如果查询工具返回内容中的某一步骤有图，你在回答该步骤时就必须带上那张图。不要遗漏。图片应该紧跟在它所解释的步骤文字之后。
    3. **严禁编造**：不允许在查询工具返回的内容上增加无中生有的内容，你只能对查询的结果进行整合或提取，然后清晰地回答用户，**严禁编造**。
    4. **确定性**：如果用户的问题不清晰（例如只说了“机器坏了”），请追问具体的错误码或故障现象等问题的细节，不要瞎猜。
                              
    ### 工具调用格式规范
    **你必须使用标准的 OpenAI Function Calling 格式。**
    **严禁**输出 `<tool_call>`, `<function>` 等 XML 标签。
    **严禁**输出 Base64 编码。
                              
    ### 回答格式
    - 使用清晰的 Markdown 格式。
    - 在回答末尾列出【参考来源文件】。
    """)

# 定义状态
class AgentState(TypedDict):
    messages: Annotated[Sequence[BaseMessage], add_messages]

# 定义节点：调用模型
async def call_model(state: AgentState):
    messages = state["messages"]
    last_message = messages[-1]

    # 1. [记录工具防死循环拦截] 保持不变
    # 如果刚执行完记录工具，直接结束，不让模型再废话
    if isinstance(last_message, ToolMessage) and "该问题已成功记录到待解答问题库" in str(last_message.content):
        print("🛑 [系统拦截] 检测到刚刚执行了记录工具，强制结束对话循环。")
        return {
            "messages": [
                AIMessage(content="抱歉，当前知识库中暂未收录此问题。我已将其自动记录到【待解答问题库】，工程师将在后续更新中补充该内容。")
            ]
        }

    print("🤖 [Agent 动作] 正在思考 (调用大模型)...")
    
    # 2. 确保 SystemPrompt 在最前
    if not isinstance(messages[0], SystemMessage):
        messages = [system_prompt] + messages
    else:
        messages[0] = system_prompt

    # 3. 执行中间件：处理图片 Base64
    messages_with_images = convert_to_multimodal_messages(messages)
    
    # ==================== [智能检测是否搜过] ====================
    has_searched = False
    
    # 倒序遍历消息，只检查“当前用户提问之后”产生的动作
    for i in range(len(messages) - 1, -1, -1):
        msg = messages[i]
        
        # 遇到用户消息，说明回到了上一轮，停止检查
        if isinstance(msg, HumanMessage):
            break
            
        # 检查 AI 消息中的工具调用
        if isinstance(msg, AIMessage) and msg.tool_calls:
            for tc in msg.tool_calls:
                if tc["name"] == "search_factory_knowledge":
                    has_searched = True
                    break
        
        if has_searched:
            break
    
    # 动态构建工具列表
    current_tools = list(tools)
    if has_searched:
        print("🛑 [系统强制] 检测到**本轮对话**已执行过搜索，正在移除搜索工具...")
        current_tools = [t for t in tools if t.name != "search_factory_knowledge"]
    
    model_with_tools = llm.bind_tools(current_tools)
    # ====================================================================
    
    try:
        response = await model_with_tools.ainvoke(messages_with_images)
        
        # ==================== [XML 强力修复补丁] ====================
        content_str = str(response.content)
        
        if not response.tool_calls and ("<tool_call>" in content_str or "<function=" in content_str):
            print(f"⚠️ [兼容性修复] 检测到 Qwen 返回了 XML...")
            
            func_pattern = r"<function=['\"]?(\w+)['\"]?>| <function=['\"]?(\w+)['\"]?>"
            func_match = re.search(func_pattern, content_str)
            
            if func_match:
                func_name = func_match.group(1) or func_match.group(2)
                
                # --- [防死循环拦截器] ---
                # 如果本轮搜过了，但模型还想搜，强制转为记录
                if has_searched and func_name == "search_factory_knowledge":
                    print("🛡️ [拦截成功] 模型试图二次搜索，系统强制转换为‘记录缺失知识’...")
                    func_name = "record_missing_knowledge"
                    q_match = re.search(r"<parameter=query>(.*?)</parameter>", content_str, re.DOTALL)
                    query_val = q_match.group(1).strip() if q_match else "用户遇到的未知问题"
                    
                    response.tool_calls = [{
                        "name": func_name,
                        "args": {
                            "user_query": query_val,
                            "reason": "自动拦截：知识库单次检索无果，强制转入待解答库"
                        },
                        "id": f"call_{uuid.uuid4().hex[:8]}"
                    }]
                    response.content = ""
                    return {"messages": [response]}
                # -----------------------

                args = {}
                if func_name == "search_factory_knowledge":
                    q_match = re.search(r"<parameter=query>(.*?)</parameter>", content_str, re.DOTALL)
                    if q_match: args["query"] = q_match.group(1).strip()
                        
                elif func_name == "record_missing_knowledge":
                    uq_match = re.search(r"<parameter=user_query>(.*?)</parameter>", content_str, re.DOTALL)
                    if uq_match: args["user_query"] = uq_match.group(1).strip()
                    r_match = re.search(r"<parameter=reason>(.*?)</parameter>", content_str, re.DOTALL)
                    if r_match: args["reason"] = r_match.group(1).strip()
                    else: args["reason"] = "未检索到相关文档"
                
                if args:
                    print(f"🔧 [修复成功] 提取到工具: {func_name}, 参数: {args}")
                    response.tool_calls = [{
                        "name": func_name,
                        "args": args,
                        "id": f"call_{uuid.uuid4().hex[:8]}"
                    }]
                    response.content = "" 
            
            if "<tool_call>" in str(response.content):
                clean_content = re.sub(r"<tool_call>.*?</tool_call>", "", str(response.content), flags=re.DOTALL)
                response.content = clean_content.strip()

        print("✅ [Agent 动作] 大模型思考完成")
        return {"messages": [response]}
        
    except Exception as e:
        print(f"❌ [Agent 报错] 模型调用失败: {e}")
        return {"messages": [AIMessage(content=f"模型调用出错: {str(e)}")]}

# 定义边：判断是否结束
def should_continue(state: AgentState):
    last_message = state["messages"][-1]
    if last_message.tool_calls:
        return "tools"
    return "__end__"

# --- 构建图 ---
workflow = StateGraph(AgentState)

workflow.add_node("agent", call_model)
workflow.add_node("tools", ToolNode(tools))

workflow.set_entry_point("agent")

workflow.add_conditional_edges(
    "agent",
    should_continue,
    {
        "tools": "tools",
        "__end__": "__end__"
    }
)
workflow.add_edge("tools", "agent")

# 编译图
graph_structure = workflow

print("🤖 工厂智能Agent已启动！")

# ==============================================================================
# 4. 初始化数据库 & 获取 Graph 实例
# ==============================================================================
# 用于缓存已编译的 graph，避免重复初始化
_compiled_graph = None
_db_initialized = False

async def get_graph():
    """
    返回编译后的 Graph 实例
    """
    global _compiled_graph
    
    # 如果已经编译过，直接返回
    if _compiled_graph is not None:
        return _compiled_graph
    
    print("🏗️  [Graph] 正在编译 StateGraph...")
    
    # 确保连接池已打开
    if pool.closed:
        await pool.open()

    # 编译 Graph
    _compiled_graph = graph_structure.compile(checkpointer=checkpointer)
    
    print("✅ [Graph] 编译完成")
    return _compiled_graph

# =============================================================================
# chat_stream 函数
# =============================================================================

async def chat_stream(message: str, thread_id: str):
    """
    流式对话接口
    """
    try:
        # 获取 graph（会自动初始化数据库）
        graph = await get_graph()
        config = {"configurable": {"thread_id": thread_id}}
        has_yielded = False
        
        print(f"💬 [Chat] 开始处理消息: thread_id={thread_id}")
        
        async for event in graph.astream_events(
            {"messages": [HumanMessage(content=message)]}, 
            config=config,
            version="v1"
        ):
            # ------------------------------------------------------
            # 1. 捕获大模型的流式输出 (正常对话)
            # ------------------------------------------------------
            if event["event"] == "on_chat_model_stream":
                content = event["data"]["chunk"].content
                if content:
                    # 过滤 XML 标签
                    if "<tool_call>" in content or "<function=" in content: 
                        continue
                    has_yielded = True
                    yield content
            
            # ------------------------------------------------------
            # 2. 捕获大模型非流式结果
            # ------------------------------------------------------
            elif event["event"] == "on_chat_model_end" and not has_yielded:
                output = event["data"]["output"]
                if hasattr(output, "generations") and output.generations:
                    msg = output.generations[0][0].message
                    if isinstance(msg, BaseMessage) and msg.type == "ai" and msg.content:
                        if not msg.tool_calls:
                            has_yielded = True
                            yield msg.content

            # ------------------------------------------------------
            # 3. 捕获 Agent 节点的直接输出
            # ------------------------------------------------------
            elif event["event"] == "on_chain_end" and event["name"] == "agent":
                # 获取节点返回的数据
                data = event["data"].get("output")
                # 检查数据格式是否符合 {"messages": [...]}
                if data and isinstance(data, dict) and "messages" in data:
                    last_msg = data["messages"][-1]
                    
                    # 只有当：
                    # 1. 之前没有输出过内容 (避免和流式输出重复)
                    # 2. 是 AI 消息
                    # 3. 有内容
                    if (not has_yielded and 
                        isinstance(last_msg, AIMessage) and 
                        last_msg.content):
                        
                        print(f"⚡ [Chat] 捕获到系统拦截消息: {last_msg.content[:20]}...")
                        has_yielded = True
                        yield last_msg.content

    except Exception as e:
        error_msg = f"\n\n❌ 对话处理失败: {str(e)}\n"
        print(f"❌ [Chat] {error_msg}")
        import traceback
        traceback.print_exc()
        yield error_msg

# 获取历史记录的函数 (供前端加载使用)
async def get_history(thread_id: str):
    """
    从 PostgreSQL 读取指定 thread_id 的历史聊天记录
    """
    graph = await get_graph()
    config = {"configurable": {"thread_id": thread_id}}
    
    # 获取当前状态
    state_snapshot = await graph.aget_state(config)
    
    if not state_snapshot.values:
        return []
    
    messages = state_snapshot.values.get("messages", [])
    
    # 将 LangChain Message 对象转换为前端可读的 JSON 格式
    formatted_history = []
    for msg in messages:
        role = "user" if isinstance(msg, HumanMessage) else "ai"
        # 过滤掉 ToolMessage，只显示用户和 AI 的对话
        if isinstance(msg, (HumanMessage, AIMessage)) and msg.content:
             # 如果 AI 消息是空的 (可能是在调用工具)，跳过
            if role == "ai" and not msg.content:
                continue
            # 如果是 XML 乱码，跳过
            if "<tool_call>" in str(msg.content):
                continue
                
            formatted_history.append({
                "role": role,
                "content": msg.content
            })
            
    return formatted_history

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
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                );
            """)

            print("✅ [Database] 表结构验证通过！")

    # --- 3. 初始化默认管理员账号 ---
    # 这个函数在之前定义过，确保它被调用
    await init_default_user()

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
async def db_get_user_threads(user_id: str):
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                SELECT thread_id, title, updated_at 
                FROM user_threads 
                WHERE user_id = %s 
                ORDER BY updated_at DESC
            """, (user_id,))
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
async def db_create_thread(user_id: str, title: str = "新会话"):
    thread_id = str(uuid.uuid4())
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("""
                INSERT INTO user_threads (thread_id, user_id, title)
                VALUES (%s, %s, %s)
            """, (thread_id, user_id, title))
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
async def db_get_thread_history(thread_id: str):
    """
    通过 LangGraph 的 checkpointer 获取指定 thread_id 的历史消息
    """
    # 1. 获取编译好的图
    graph = await get_graph()
    
    # 2. 构造配置
    config = {"configurable": {"thread_id": thread_id}}
    
    # 3. 获取当前状态快照
    state_snapshot = await graph.aget_state(config)
    
    # 4. 提取消息
    # 如果该 thread_id 不存在或没有历史，values 会是空的
    messages = state_snapshot.values.get("messages", [])
    
    # 5. 格式化为前端需要的 JSON 格式
    formatted_history = []
    for msg in messages:
        # 过滤掉 SystemMessage
        if isinstance(msg, SystemMessage):
            continue
            
        role = "user" if isinstance(msg, HumanMessage) else "ai"
        content = msg.content
        
        # 过滤掉工具调用请求 (ToolMessage 和含有 tool_calls 的 AIMessage 通常不展示给用户看，除非你想展示调试信息)
        # 这里我们只展示最终的用户提问和 AI 回答
        if isinstance(msg, ToolMessage):
            continue
        if isinstance(msg, AIMessage) and msg.tool_calls:
            continue
        if not content: # 如果内容为空（比如纯工具调用），跳过
            continue
            
        # 简单清洗 XML 标签（防止残留）
        if isinstance(content, str):
             if "<tool_call>" in content:
                continue
        
        formatted_history.append({
            "role": role,
            "content": content
        })
        
    return formatted_history

# 删除会话及其历史记录
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