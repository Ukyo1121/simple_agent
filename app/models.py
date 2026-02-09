# app/models.py
from pydantic import BaseModel
from typing import Optional,Union,List,Dict,Any

class ChatRequest(BaseModel):
    query: str          # 用户的问题
    thread_id: str      # 用于 LangGraph 记忆的会话 ID
    temp_context: Optional[Union[List[Dict[str, Any]], Dict[str, Any]]] = None # 用于携带临时上传的文件/图片信息