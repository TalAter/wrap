FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY *.py .

# Mount points:
#   /app/eval  — examples directory
#   /app/src   — schema + output

ENTRYPOINT ["python", "optimize.py"]
