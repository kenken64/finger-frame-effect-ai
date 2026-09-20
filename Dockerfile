FROM python:3.12-slim

WORKDIR /app

# The web server only needs requests. The remaining dependencies in
# requirements.txt are for the optional local CLI video-processing tools.
RUN pip install --no-cache-dir "requests>=2.31"

COPY . .

# Railway provides PORT at runtime. HOST must be public inside the container;
# server.py defaults to 127.0.0.1 when run directly on a developer machine.
ENV HOST=0.0.0.0 \
    PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

CMD ["python", "server.py"]
