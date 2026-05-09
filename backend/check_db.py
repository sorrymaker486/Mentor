import sqlite3

# 连接到数据库文件
conn = sqlite3.connect('users.db')
cursor = conn.cursor()

# 执行查询语句，查看 users 表的所有内容
cursor.execute("SELECT id, username, password FROM users")
rows = cursor.fetchall()

print("--- 数据库中的用户信息 ---")
for row in rows:
    print(f"ID: {row[0]}, 用户名: {row[1]}, 密码(哈希): {row[2]}")

conn.close()