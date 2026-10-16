# Optional: builds a self-contained Umbryx image, for people who prefer an image over the
# bind-mounted files that docker-compose.yml uses.
#
#   docker build -t umbryx .
#   docker run -d --name umbryx --restart unless-stopped \
#     -p 3443:3443 -p 3000:3000 -v umbryx-data:/data -e UMBRYX_HOSTS=192.168.1.50 umbryx
#
# The server uses only the Python standard library, so there is nothing to pip install.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
RUN useradd --system --uid 10001 --home-dir /app umbryx \
 && mkdir -p /data \
 && chown umbryx /data

WORKDIR /app
COPY *.py ./
COPY public ./public

USER umbryx
EXPOSE 3000 3443
VOLUME /data
HEALTHCHECK --interval=30s --timeout=6s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:3000/api/info', timeout=4)"

CMD ["python", "-u", "server.py", "--data", "/data", "--config", "/data/config.json"]
