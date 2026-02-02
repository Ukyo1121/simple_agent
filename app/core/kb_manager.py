# app/core/kb_manager.py

import os
import shutil
import fitz  # PyMuPDF
import nest_asyncio
import requests
from typing import List, Dict,Optional
from fastapi import UploadFile
from llama_index.core import Document, VectorStoreIndex, StorageContext, Settings,SimpleDirectoryReader
from llama_index.vector_stores.elasticsearch import ElasticsearchStore
from app.core.agent import GLOBAL_EMBED_MODEL 
from dotenv import load_dotenv

load_dotenv(override=True)
nest_asyncio.apply()

ES_URL = "http://localhost:9200"
INDEX_NAME = "factory_knowledge"
UPLOAD_DIR = "./factory_docs"
IMAGES_DIR = "./factory_images"
API_BASE_URL = os.getenv("API_BASE_URL", "http://localhost:8000")

# 确保目录存在
os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(IMAGES_DIR, exist_ok=True)

# -----------------------------------------------------------
# 1. 核心算法：按坐标提取图文，保持顺序
# -----------------------------------------------------------
def parse_pdf_with_layout(pdf_path: str, file_name: str) -> List[Document]:
    """
    使用 PyMuPDF 获取页面上的文字块和图片块，并根据 Y 轴坐标进行混合排序。
    返回包含精确图文顺序的 Document 列表。
    """
    doc = fitz.open(pdf_path)
    base_name = os.path.splitext(file_name)[0]
    llama_documents = []

    print(f"📄 开始进行图文混排解析: {file_name}")

    for page_index, page in enumerate(doc):
        # 1. 获取所有图片对象
        image_list = page.get_images(full=True)
        page_items = [] # 用于存放 (Y坐标, 内容字符串) 的临时列表

        # --- A. 处理图片 ---
        for img_index, img in enumerate(image_list):
            xref = img[0]
            # 获取图片在页面上的坐标 (Rect)
            # 注意：如果一张图被复用多次，get_image_rects 会返回多个位置，这里简化取第一个
            rects = page.get_image_rects(xref)
            if not rects: 
                continue
            
            # 这里的 y1 (底部坐标) 通常用于决定图片是在某段文字之后
            # 我们用 y0 (顶部坐标) 也可以，视排版而定，通常 y0 更符合“读到这里看到了图”
            y_pos = rects[0].y1 
            
            # 提取图片并保存到本地
            base_image = doc.extract_image(xref)
            image_bytes = base_image["image"]
            image_ext = base_image["ext"]
            
            # 文件名：文件名_p页码_索引.png
            image_filename = f"{base_name}_p{page_index+1}_{img_index}.{image_ext}"
            image_path = os.path.join(IMAGES_DIR, image_filename)
            
            with open(image_path, "wb") as f:
                f.write(image_bytes)
            
            # 构造 Markdown 图片链接
            # 这里直接生成 URL，稍后拼接到文本里
            img_url = f"/images/{image_filename}"
            markdown_img = f"\n\n![示意图]({img_url})\n\n"
            
            # 存入列表: (坐标, 类型, 内容)
            page_items.append({
                "y": y_pos,
                "type": "image",
                "content": markdown_img
            })

        # --- B. 处理文字 ---
        # get_text("blocks") 返回 (x0, y0, x1, y1, "text", block_no, block_type)
        text_blocks = page.get_text("blocks")
        for block in text_blocks:
            # block[6] == 0 代表这是文字块 (1是图片块，但PyMuPDF的图片块往往不准，所以我们上面单独处理了图片)
            if block[6] == 0:
                text_content = block[4].strip()
                if text_content:
                    page_items.append({
                        "y": block[3], # 使用 y1 (底部) 作为排序依据
                        "type": "text",
                        "content": text_content
                    })

        # --- C. 核心：按 Y 轴坐标排序 ---
        # 这样就能保证：上面的文字 -> 中间的图 -> 下面的文字
        page_items.sort(key=lambda x: x["y"])

        # --- D. 拼接成最终文本 ---
        final_page_text = ""
        for item in page_items:
            final_page_text += item["content"] + "\n"

        # --- E. 创建 Document 对象 ---
        doc_obj = Document(text=final_page_text)
        doc_obj.metadata = {
            "file_name": file_name,
            "page_label": str(page_index + 1),
            # 这里虽然我们在text里已经嵌入了图片，但metadata里留个底也是好的
            "has_images": True if image_list else False 
        }
        llama_documents.append(doc_obj)

    print(f"✅ 解析完成，共 {len(llama_documents)} 页")
    return llama_documents

# -----------------------------------------------------------
# 2. ES 操作函数
# -----------------------------------------------------------
def list_files_in_es() -> List[Dict]:
    search_url = f"{ES_URL}/{INDEX_NAME}/_search"
    payload = {
        "size": 0, "aggs": {"unique_files": {"terms": {"field": "metadata.file_name.keyword", "size": 1000}}}
    }
    try:
        response = requests.get(search_url, json=payload)
        if response.status_code == 200:
            buckets = response.json().get('aggregations', {}).get('unique_files', {}).get('buckets', [])
            return [{"name": b['key'], "chunks": b['doc_count']} for b in buckets]
        return []
    except Exception as e:
        return []

def delete_file_from_es(filename: str) -> bool:
    url = f"{ES_URL}/{INDEX_NAME}/_delete_by_query"
    payload = {"query": {"term": {"metadata.file_name.keyword": filename}}}
    try:
        response = requests.post(url, json=payload)
        return response.status_code == 200
    except:
        return False

# -----------------------------------------------------------
# 3. 入库入口
# -----------------------------------------------------------
async def ingest_from_local_path(file_path: str, original_filename: str):
    print(f"📂 [Debug] 开始处理本地文件: {file_path}")

    try:
        # 1. 解析文档
        documents = []
        if original_filename.lower().endswith(".pdf"):
            print("   [Debug] 检测到 PDF，正在调用 parse_pdf_with_layout...")
            documents = parse_pdf_with_layout(file_path, original_filename)
        else:
            print("   [Debug] 检测到其他格式，调用 SimpleDirectoryReader...")
            documents = SimpleDirectoryReader(input_files=[file_path]).load_data()
            for doc in documents:
                doc.metadata["file_name"] = original_filename
                doc.metadata["page_label"] = "1"

        print(f"   [Debug] 文档解析完成，共生成 {len(documents)} 个 Document 对象。")

        # 2. 显存保护配置
        Settings.embed_model = GLOBAL_EMBED_MODEL
        Settings.chunk_size = 512

        # 3. 测试 ES 连接性 (新增)
        print(f"   [Debug] 正在尝试连接 Elasticsearch ({ES_URL})...")
        try:
            test_res = requests.get(ES_URL, timeout=3)
            if test_res.status_code == 200:
                print(f"   ✅ [Debug] Elasticsearch 连接成功! Version: {test_res.json().get('version', {}).get('number')}")
            else:
                print(f"   ⚠️ [Debug] Elasticsearch 返回非200状态: {test_res.status_code}")
        except Exception as conn_err:
            print(f"   ❌ [Debug] 无法连接到 Elasticsearch! 请检查 Docker 是否开启，或者地址是否写错。错误: {conn_err}")
            raise conn_err

        # 4. 存入 ES
        print(f"⏳ [Debug] 开始初始化 VectorStoreIndex (这步可能需要下载模型或连接数据库)...")
        vector_store = ElasticsearchStore(
            es_url=ES_URL,
            index_name=INDEX_NAME,
        )
        storage_context = StorageContext.from_defaults(vector_store=vector_store)
        
        print("   [Debug] 开始执行 from_documents (向量化写入)...")
        VectorStoreIndex.from_documents(
            documents,
            storage_context=storage_context,
            show_progress=True
        )
        
        print(f"🎉 [Debug] {original_filename} 全部处理完成！")
        return len(documents)
    
    except Exception as inner_e:
        print(f"❌ [Debug] ingest_from_local_path 内部发生错误: {inner_e}")
        raise inner_e # 继续向上抛出，给 main.py 打印堆栈

# 处理上传文件
async def ingest_file(file: UploadFile):
    # 1. 保存文件到磁盘
    file_path = os.path.join(UPLOAD_DIR, file.filename)
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    
    # 2. 调用通用逻辑
    return await ingest_from_local_path(file_path, file.filename)