import json
from sqlalchemy.orm import Session
from main import engine, CourseDB, ChapterDB, SessionLocal

# 从执行摘要整理的 JSON 数据
courses_data = [
    {
        "id": "math",
        "name": "高等数学",
        "source": "同济大学数学系，《高等数学》（第七版）",
        "description": "涵盖一元微积分基本概念...",
        "learning_goals": ["理解极限、连续、导数等概念", "掌握求导法则", "熟练应用积分公式"],
        "chapters": [
            {"id": "math-1", "title": "函数与极限", "desc": "函数的定义与基本性质...", "subsections": ["函数的概念", "映射"], "keywords": ["函数", "极限"]},
            # ... 按照执行摘要补充完整 ...
        ]
    },
    # ... 其他三门课程 ...
]

def seed():
    db = SessionLocal()
    try:
        for c_data in courses_data:
            # 检查是否已存在
            course = db.query(CourseDB).filter(CourseDB.id == c_data["id"]).first()
            if not course:
                course = CourseDB(
                    id=c_data["id"],
                    name=c_data["name"],
                    source=c_data["source"],
                    description=c_data["description"],
                    learning_goals=json.dumps(c_data["learning_goals"], ensure_ascii=False)
                )
                db.add(course)
                db.flush() # 获取 course 对象以便关联章节

            # 插入/更新章节
            for ch in c_data["chapters"]:
                chapter = db.query(ChapterDB).filter(ChapterDB.id == ch["id"]).first()
                if not chapter:
                    new_ch = ChapterDB(
                        id=ch["id"],
                        course_id=course.id,
                        title=ch["title"],
                        desc=ch["desc"],
                        subsections=json.dumps(ch["subsections"], ensure_ascii=False),
                        keywords=json.dumps(ch["keywords"], ensure_ascii=False)
                    )
                    db.add(new_ch)
        db.commit()
        print("数据初始化成功！")
    except Exception as e:
        db.rollback()
        print(f"失败: {e}")
    finally:
        db.close()

if __name__ == "__main__":
    seed()