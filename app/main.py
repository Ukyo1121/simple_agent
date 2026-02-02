# app/main.py
import os
import shutil
import json
import uuid
from typing import Optional
import pandas as pd
import io
from fastapi import FastAPI, UploadFile, File, HTTPException, Form
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel

from app.models import ChatRequest
from app.core.agent import chat_stream, UNANSWERED_FILE
from app.core.kb_manager import list_files_in_es, delete_file_from_es, ingest_file, ingest_from_local_path, UPLOAD_DIR, IMAGES_DIR

# --------------------------------------------------------------------------
# 1. 初始化本地语音模型 (Faster-Whisper)
# --------------------------------------------------------------------------
# 为了防止显存(VRAM)溢出，强制使用 "cpu" 和 "int8" 量化
# "small" 模型对中文识别效果很好，且在 CPU 上运行速度也很快
try:
    # download_root 可以指定模型下载路径，避免每次都下
    voice_model = WhisperModel("small", device="cpu", compute_type="int8", download_root="./models/whisper")
except Exception as e:
    print(f"语音模型加载失败: {e}")
    voice_model = None

# --------------------------------------------------------------------------
# 2. 框架配置
# --------------------------------------------------------------------------
app = FastAPI(title="工厂智能助手 API", version="1.0")

app.mount("/files", StaticFiles(directory=UPLOAD_DIR), name="files")
app.mount("/images", StaticFiles(directory=IMAGES_DIR), name="images")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def read_root():
    return {"message": "Factory AI Agent Service is Running"}

# --------------------------------------------------------------------------
# 3. 核心接口
# --------------------------------------------------------------------------

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    """对话接口 (流式)"""
    return StreamingResponse(
        chat_stream(request.query, request.thread_id),
        media_type="text/event-stream"
    )

@app.post("/voice-to-text")
async def voice_to_text_endpoint(file: UploadFile = File(...)):
    """
    语音转文字接口 (Local Faster-Whisper)
    """
    if not voice_model:
        raise HTTPException(status_code=500, detail="语音模型未加载，请检查后台日志")

    # 1. 保存上传的临时音频文件
    temp_filename = f"temp_{file.filename}"
    try:
        with open(temp_filename, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
        
        # 2. 调用模型进行识别
        # beam_size=5 提升准确率
        segments, info = voice_model.transcribe(temp_filename, beam_size=5, language="zh")
        
        # 3. 拼接结果
        full_text = "".join([segment.text for segment in segments])
        
        # 4. 删除临时文件
        os.remove(temp_filename)
        
        print(f"🎤 语音识别结果: {full_text}")
        return {"text": full_text}

    except Exception as e:
        if os.path.exists(temp_filename):
            os.remove(temp_filename)
        print(f"❌ 语音识别出错: {e}")
        raise HTTPException(status_code=500, detail=f"识别失败: {str(e)}")

# --------------------------------------------------------------------------
# 4. 知识库接口
# --------------------------------------------------------------------------
@app.get("/knowledge/files")
def get_files():
    return list_files_in_es()

@app.delete("/knowledge/files/{filename}")
def delete_file(filename: str):
    if delete_file_from_es(filename):
        return {"message": f"{filename} 已删除"}
    raise HTTPException(status_code=500, detail="删除失败")

@app.post("/knowledge/upload")
async def upload_file(file: UploadFile = File(...)):
    print(f"\n📥 [Debug] 收到文件上传请求: filename={file.filename}, content_type={file.content_type}")
    
    # 1. 检查 python-multipart 是否正常工作
    try:
        file_size = 0
        # 尝试读取一点点数据，测试 UploadFile 对象是否健康
        content_sample = await file.read(1024)
        file_size = len(content_sample)
        await file.seek(0) # 读完记得指针归位
        print(f"✅ [Debug] 文件对象读取正常，前1KB已读取。")
    except Exception as e:
        print(f"❌ [Debug] UploadFile 对象损坏 (可能是 python-multipart 未安装或版本不兼容): {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail="文件接收失败，请检查服务器 python-multipart 依赖")

    try:
        # 2. 调用核心逻辑
        print("🚀 [Debug] 正在调用 kb_manager.ingest_file ...")
        num = await ingest_file(file)
        print(f"✅ [Debug]入库成功，片段数: {num}")
        return {"message": "入库成功", "chunks": num}
    except Exception as e:
        # 3. 捕获核心逻辑的所有报错，并打印堆栈！
        print(f"❌ [Debug] 知识库入库过程发生致命错误: {type(e).__name__} - {e}")
        print("-" * 60)
        import traceback
        traceback.print_exc()  # <--- 这行代码会把真正的报错打印在黑色窗口里
        print("-" * 60)
        raise HTTPException(status_code=500, detail=f"后端处理失败: {str(e)}")

@app.get("/admin/unanswered_questions")
def get_unanswered_questions():
    """
    获取所有待解答的问题列表
    """
    if not os.path.exists(UNANSWERED_FILE): return {"count": 0, "questions": []}
    try:
        with open(UNANSWERED_FILE, "r", encoding="utf-8") as f: data = json.load(f)
        pending = [q for q in data if q.get("status") == "pending"]
        return {"count": len(pending), "questions": pending}
    except: return {"count": 0, "questions": []}

@app.post("/admin/solve_question")
async def solve_question(
    query: str = Form(...),
    answer_text: Optional[str] = Form(None),
    custom_filename: Optional[str] = Form(None),
    file: Optional[UploadFile] = File(None)
):
    """
    解决问题：接收人工回答（文字或文件），生成文档入库，并更新状态
    """
    # A. 校验
    if not answer_text and not file:
        raise HTTPException(status_code=400, detail="必须提供文字回答或上传文件")

    try:
        # B. 处理回答并入库
        ingested_filename = ""
        
        # 情况1：上传了文件 (PDF/Word等)
        if file:
            file_path = os.path.join(UPLOAD_DIR, file.filename)
            with open(file_path, "wb") as buffer:
                shutil.copyfileobj(file.file, buffer)
            
            # 入库
            await ingest_from_local_path(file_path, file.filename)
            ingested_filename = file.filename

        # 情况2：纯文字回答 (生成一个 .txt 文件)
        elif answer_text:
            # 确定文件名
            if custom_filename and custom_filename.strip():
                # 使用用户自定义的文件名
                safe_name = custom_filename.strip()
                # 自动补全 .txt 后缀
                if not safe_name.lower().endswith(".txt"):
                    safe_name += ".txt"
                txt_filename = safe_name
            else:
                # 默认逻辑：生成带随机ID的文件名
                short_id = str(uuid.uuid4())[:8]
                txt_filename = f"人工解答_{short_id}.txt"
            
            txt_path = os.path.join(UPLOAD_DIR, txt_filename)
            
            # 写入内容：明确的问题和答案格式
            content = f"【故障/问题】\n{query}\n\n【解决方案】\n{answer_text}"
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(content)
            
            # 入库
            await ingest_from_local_path(txt_path, txt_filename)
            ingested_filename = txt_filename

        # C. 更新 JSON 状态
        if os.path.exists(UNANSWERED_FILE):
            with open(UNANSWERED_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
            
            found = False
            for item in data:
                if item["query"] == query and item["status"] == "pending":
                    item["status"] = "solved"
                    item["solved_at"] = "now" # 简化处理
                    item["solution_source"] = ingested_filename
                    found = True
                    break
            
            # 写回
            with open(UNANSWERED_FILE, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

        return {"message": "处理成功，知识已入库", "file": ingested_filename}

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    
# --------------------------------------------------------------------------
# 5. 零件生命周期数据可视化接口
# --------------------------------------------------------------------------

@app.post("/api/upload_lifecycle")
async def upload_lifecycle_data(file: UploadFile = File(...)):
    """
    接收 CSV 或 Excel 文件，解析为 JSON 数据供前端可视化使用
    """
    try:
        contents = await file.read()
        filename = file.filename.lower()
        
        df = None
        
        # --- 分支 1: 处理 Excel (.xlsx) ---
        if filename.endswith(".xlsx") or filename.endswith(".xls"):
            # read_excel 需要二进制流 (BytesIO)，不需要 decode
            df = pd.read_excel(io.BytesIO(contents))
            
        # --- 分支 2: 处理 CSV (.csv) ---
        else:
            # read_csv 需要文本流，尝试 utf-8 和 gbk 解码
            try:
                df = pd.read_csv(io.StringIO(contents.decode('utf-8')))
            except UnicodeDecodeError:
                df = pd.read_csv(io.StringIO(contents.decode('gbk')))
        
        # --- 通用数据清洗逻辑 ---
        # 确保数值列是数字类型，如果为空则填0
        numeric_cols = ['总耗时(分钟)', '坐标 X', '坐标 Y']
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors='coerce').fillna(0)
        
        # 填充空字符串，防止前端报错
        df = df.fillna("")

        # 将 DataFrame 转为字典列表返回
        data = df.to_dict(orient="records")
        return {"data": data, "count": len(data)}
        
    except Exception as e:
        print(f"文件解析错误: {e}")
        return {"error": f"解析失败: {str(e)}"}