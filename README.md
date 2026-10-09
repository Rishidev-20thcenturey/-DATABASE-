# -DATABASE-
import sqlite3

# 1. Connect to the database (if the file doesn't exist, Python creates it automatically)
connection = sqlite3.connect("my_database.db")

# 2. Create a cursor object (needed to execute SQL commands)
cursor = connection.cursor()

# 3. Create a table named 'users' with columns: id, name, and age
cursor.execute("""
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        age INTEGER
    )
""")

# 4. Insert some records into the table
cursor.execute("INSERT INTO users (name, age) VALUES ('Rahim', 25)")
cursor.execute("INSERT INTO users (name, age) VALUES ('Karim', 30)")

# Save (commit) the changes to the database permanently
connection.commit()

# 5. Read/Fetch data from the database
cursor.execute("SELECT * FROM users")
rows = cursor.fetchall()

print("Database Records:")
for row in rows:
    print(row)

# 6. Close the connection when done
connection.close()
