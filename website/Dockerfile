FROM node:22-alpine AS build
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html styles.css main.js ./
COPY scripts ./scripts
COPY src ./src
COPY public ./public
COPY legal ./legal
# The shown release's notes, put here by the automatic update (deploy/auto-release.sh). Empty in
# the repository (only its README); the build then shows a link to the notes on GitHub.
COPY release-notes ./release-notes
ARG SOURCE_REVISION=development
ENV SOURCE_REVISION=$SOURCE_REVISION
# Pleni's version to show (the image has no root package.json to read): the release checked on
# GitHub Releases and npm, e.g. --build-arg PLENI_VERSION=0.2.0. The build stops without it.
ARG PLENI_VERSION
ENV PLENI_VERSION=$PLENI_VERSION
RUN node scripts/build.mjs

FROM nginx:1.30.5-alpine
ARG SOURCE_REVISION=development
LABEL org.opencontainers.image.title="getplenipo.com website" \
      org.opencontainers.image.source="https://github.com/Seckcey/pleni" \
      org.opencontainers.image.revision=$SOURCE_REVISION
COPY nginx.conf /etc/nginx/nginx.conf
COPY --from=build /site/dist /usr/share/nginx/html
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["nginx", "-g", "daemon off;"]
