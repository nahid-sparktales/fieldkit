FROM node:24-alpine
RUN apk add --no-cache python3 docker-cli
WORKDIR /runner
COPY runner/server.mjs runner/javascript.cjs runner/python.py ./
CMD ["node", "/runner/server.mjs"]
