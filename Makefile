.PHONY: start backend frontend install

# Start both backend and frontend (opens backend in a new window)
start:
	start "Makros Backend" cmd /k "cd /d $(CURDIR)/backend && venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload"
	npx expo start

# Start backend only
backend:
	cd backend && venv\Scripts\activate && uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

# Start frontend only
frontend:
	npx expo start --clear

# Install all dependencies
install:
	npm install
	cd backend && pip install -r requirements.txt
