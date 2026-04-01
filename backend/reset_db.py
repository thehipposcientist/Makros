"""
Wipes all user data (keeps exercises + foods reference data).
Can run while the backend server is running — no restart needed.

Usage:
    cd backend
    python reset_db.py
"""
import os, sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), "workoutpal.db")

if not os.path.exists(DB_PATH):
    print("No database found — start the backend first to create it.")
    raise SystemExit(1)

conn = sqlite3.connect(DB_PATH)
cur  = conn.cursor()

USER_TABLES = [
    'exercise_sets', 'meal_items', 'workout_exercises',
    'workout_sessions', 'meals',
    'user_preferences', 'user_goals', 'user_profiles', 'user',
]
for table in USER_TABLES:
    cur.execute(f'DELETE FROM {table}')
    print(f'Cleared {table}: {cur.rowcount} rows deleted')

conn.commit()

for table in ['user', 'exercises', 'foods']:
    cur.execute(f'SELECT COUNT(*) FROM {table}')
    print(f'{table}: {cur.fetchone()[0]} rows remaining')

conn.close()
print('\nDone — all users cleared. Reference data kept. No restart needed.')
