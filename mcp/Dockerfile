FROM python:3.11-slim

WORKDIR /app
COPY . /app

RUN pip install --upgrade pip uv
RUN uv pip install --system -e .

CMD ["uvx", "conflux-mcp-demo"]