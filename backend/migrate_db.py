# migrate_db.py
from sqlalchemy import text
from main import engine

def migrate():
    with engine.begin() as conn:
        print("正在更新旧数据...")
        # 修正章节名称
        conn.execute(text("UPDATE chat_sessions SET chapter='定积分的应用' WHERE chapter='定积分+应用'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='函数与极限' WHERE chapter='第一章：极限'"))
        # 与教材目录对齐：高等数学（同济第七版上册 1–6 章）
        conn.execute(text("UPDATE chat_sessions SET chapter='第一章 函数与极限' WHERE chapter='函数与极限'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第二章 导数与微分' WHERE chapter='导数与微分'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第三章 微分中值定理与导数的应用' WHERE chapter IN ('中值定理与导数应用','微分中值定理与导数应用','微分中值定理与导数的应用')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第四章 不定积分' WHERE chapter='不定积分'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第五章 定积分' WHERE chapter='定积分'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第六章 定积分的应用' WHERE chapter IN ('定积分的应用','多元函数基础')"))
        # 计算机架构（张晨曦第二版）
        conn.execute(text("UPDATE chat_sessions SET chapter='第一章 计算机系统结构的基本概念' WHERE chapter='计算机系统概述'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第二章 计算机指令集结构' WHERE chapter IN ('数据表示与运算','算术逻辑与编码')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第三章 流水线和向量处理技术' WHERE chapter IN ('指令系统','处理器结构与流水线','CPU与流水线')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第四章 指令级并行' WHERE chapter='并行与多核架构'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第五章 存储层次结构' WHERE chapter='存储层次结构'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第六章 输入输出系统' WHERE chapter IN ('I/O系统','设备管理与I/O','性能评价与新技术')"))
        # 自然语言处理（宗成庆第二版前六章）
        conn.execute(text("UPDATE chat_sessions SET chapter='第一章 绪论' WHERE chapter IN ('NLP基础','NLP概论与预处理')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第二章 预备知识' WHERE chapter IN ('分词与词向量','词向量与语言模型')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第三章 形式语言与自动机及其应用' WHERE chapter IN ('语言模型','序列模型与深度学习')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第四章 语料库与语言知识库' WHERE chapter IN ('序列标注','序列标注与文本分类')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第五章 词法分析与词性标注' WHERE chapter IN ('文本分类','机器翻译与对话')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第六章 命名实体识别' WHERE chapter IN ('Transformer基础','预训练模型与前沿')"))
        # 操作系统（汤子瀛第四版 1–6 章）
        conn.execute(text("UPDATE chat_sessions SET chapter='第一章 操作系统引论' WHERE chapter='操作系统概述'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第二章 进程的描述与控制' WHERE chapter='进程与线程'"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第三章 处理机调度与死锁' WHERE chapter IN ('并发控制与死锁','死锁')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第四章 存储器管理' WHERE chapter IN ('内存管理','存储管理')"))
        conn.execute(text("UPDATE chat_sessions SET chapter='第六章 输入输出系统' WHERE chapter IN ('文件系统','设备管理','设备管理与I/O')"))
        print("数据库迁移完成！")

if __name__ == "__main__":
    migrate()