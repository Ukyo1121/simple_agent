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

# 加载环境变量
from dotenv import load_dotenv
load_dotenv(override=True)
# 定义待解答问题的文件路径
UNANSWERED_FILE = "unanswered_questions.json"
# 定义本地图片存储路径
IMAGES_DIR = "./factory_images"

es_url = "http://localhost:9200"
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")

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
memory = MemorySaver()
graph = workflow.compile(checkpointer=memory)

print("🤖 工厂智能Agent已启动！")

# 封装一个异步生成器函数，用于流式输出
async def chat_stream(message: str, thread_id: str):
    config = {"configurable": {"thread_id": thread_id}}
    has_yielded = False # 标记是否已经向前端发送过内容
    
    async for event in graph.astream_events(
        {"messages": [HumanMessage(content=message)]}, 
        config=config,
        version="v1"
    ):
        # 1. 捕获流式 Token (LLM 正常生成时)
        if event["event"] == "on_chat_model_stream":
             content = event["data"]["chunk"].content
             if content:
                 if "<tool_call>" in content or "<function=" in content: continue
                 has_yielded = True
                 yield content
        
        # 2. 捕获非流式最终结果 (LLM 一次性生成时)
        elif event["event"] == "on_chat_model_end" and not has_yielded:
            output = event["data"]["output"]
            if hasattr(output, "generations") and output.generations:
                msg = output.generations[0][0].message
                if isinstance(msg, BaseMessage) and msg.type == "ai" and msg.content:
                    if not msg.tool_calls:
                        if "<tool_call>" in msg.content: continue
                        has_yielded = True
                        yield msg.content

        # 3. 捕获系统拦截/硬编码消息] 
        # 当 call_model 直接 return AIMessage (跳过大模型) 时，触发的是 on_chain_end
        elif event["event"] == "on_chain_end" and event["name"] == "agent":
            # 只有当之前没有从 LLM 拿到数据时，才检查这里的输出
            if not has_yielded:
                outputs = event["data"].get("output")
                if outputs and isinstance(outputs, dict) and "messages" in outputs:
                    last_msg = outputs["messages"][-1]
                    # 确保是 AI 消息且有内容
                    if isinstance(last_msg, AIMessage) and last_msg.content:
                        # 再次检查是不是 XML 乱码（双重保险）
                        if "<tool_call>" in last_msg.content: continue
                        
                        has_yielded = True
                        yield last_msg.content
        # ========================================================================

# ==============================================================================
# 4. 交互式运行
# ==============================================================================
def main():
    print("\n你可以开始提问了 (输入 'q' 退出)")
    
    # 定义线程 ID，LangGraph 通过这个 ID 来区分不同的对话历史
    # 如果你想开启一段全新的对话（忘记过去），只需要换一个 ID (例如 "thread_2")
    config = {"configurable": {"thread_id": "factory_user_001"}}
    
    while True:
        user_input = input("\n请提问: ")
        if user_input.lower() == 'q':
            break
            
        print("\n[Agent 思考中...]")

        # 我们只把当前最新的这一句话传给 Agent
        # Agent 会根据 config 里的 thread_id 自动去 memory 里查找之前的聊天记录
        inputs = {"messages": [("user", user_input)]}
        
        # stream_mode="values" 会返回当前时刻完整的消息列表（包含历史）
        # 我们只打印最后一条新增的消息
        for event in graph.stream(inputs, config=config, stream_mode="values"):
            last_message = event["messages"][-1]
            
            # 这里的逻辑是：只打印 AI 新生成的回复
            if last_message.type == "ai" and last_message.content:
                print(f"\n[助手回答]: {last_message.content}")

if __name__ == "__main__":
    main()