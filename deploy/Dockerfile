FROM python:3.13-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app/backend
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY backend ./backend
COPY frontend ./frontend
COPY models ./models
COPY LICENSE ./
RUN mkdir /data && chown 10001:10001 /data
USER 10001:10001
CMD ["sh", "-c", "exec uvicorn argus.app:create_app --factory --host 0.0.0.0 --port ${MODULE_PORT:-18333} --no-proxy-headers --no-access-log"]
