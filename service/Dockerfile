# Runs the bundled LangGraph service without the plugin.
#
# The image holds the dependencies; the sources are mounted at run time so the service and the
# plugin never disagree about what is deployed:
#
#   docker build -t polyglot-bridge-service:dev service
#   docker run --rm -p 8021:8021 -v ${PWD}/service:/app -v polyglot-dev-data:/data \
#     polyglot-bridge-service:dev
#
# The host application then points at it with lab.langgraph.url=http://127.0.0.1:8021 and lets
# the container reach it back through host.docker.internal.

FROM docker.m.daocloud.io/library/python:3.11-slim

WORKDIR /app

# The Tsinghua mirror is reachable from this network; pypi.org is not. Same pinned set as
# `requirements.txt`, which mirrors vendor-lock.json — installing langgraph and its sqlite saver
# in one command matters, see VENDOR.md.
ENV PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PYTHONUNBUFFERED=1

COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# Sources are mounted here at run time; the copy is only a fallback for a self-contained image.
COPY . /app

# Checkpoints are state, not an artefact: mount a volume here.
ENV BRIDGE_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8021

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8021/health', timeout=2)"

CMD ["python", "-m", "uvicorn", "service:app", "--host", "0.0.0.0", "--port", "8021", "--log-level", "warning"]
