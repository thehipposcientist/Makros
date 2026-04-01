"""
Re-seeds exercises and foods into an empty database.
Run while the backend is stopped, or after reset_db.py wiped the tables.

Usage:
    cd backend
    python reseed.py
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))

from app.database import engine, create_db_and_tables

print("Re-seeding exercises and foods...")
create_db_and_tables()
print("Done.")
