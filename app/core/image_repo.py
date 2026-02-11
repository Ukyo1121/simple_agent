import logging
from psycopg_pool import ConnectionPool
from typing import List, Dict, Any, Optional

logger = logging.getLogger(__name__)

class ImageRepository:
    """
    负责处理图片采集库的数据库交互。
    """
    def __init__(self, pool: ConnectionPool):
        self.pool = pool

    async def save_image_annotation(self, filename: str, file_path: str, annotation: str) -> Optional[int]:
        """
        保存图片元数据和标注到数据库。
        """
        insert_query = """
            INSERT INTO collected_images (filename, file_path, annotation)
            VALUES (%s, %s, %s)
            RETURNING id;
        """
        try:
            async with self.pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(insert_query, (filename, file_path, annotation))
                    row = await cur.fetchone()
                    if row:
                        image_id = row[0]
                        logger.info(f"Image annotation saved to DB with ID: {image_id}")
                        return image_id
        except Exception as e:
            logger.error(f"Error saving image annotation to DB: {e}")
            raise e
        return None

    async def get_recent_images(self, limit: int = 20) -> List[Dict[str, Any]]:
        """
        获取最近上传的图片列表用于展示。
        """
        select_query = """
            SELECT id, filename, file_path, annotation, created_at
            FROM collected_images
            ORDER BY created_at DESC
            LIMIT %s;
        """
        results = []
        try:
            async with self.pool.connection() as conn:
                async with conn.cursor() as cur:
                    await cur.execute(select_query, (limit,))
                    rows = await cur.fetchall()
                    for row in rows:
                        results.append({
                            "id": row[0],
                            "filename": row[1],
                            # 注意：这里返回给前端的是相对路径，前端需要拼接基础 URL
                            "file_path": row[2], 
                            "annotation": row[3],
                            "created_at": row[4].isoformat() if row[4] else None
                        })
        except Exception as e:
            logger.error(f"Error fetching recent images: {e}")
            # 这里选择不抛出异常，而是返回空列表，避免整个页面崩溃
            return []
        return results