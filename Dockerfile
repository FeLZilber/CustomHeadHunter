# One image for the dashboard and the worker. tsx and next both run from the full
# dependency tree, so the image keeps it. It holds no credentials: Compose passes them at run time.
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build && chown -R node:node .next

USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
