# One image for the dashboard and the worker. tsx and next both run from the full
# dependency tree, so the image keeps it. It holds no credentials: Compose passes them at run time.
FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx next build && chown -R node:node .next

USER node
EXPOSE 3000
CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
