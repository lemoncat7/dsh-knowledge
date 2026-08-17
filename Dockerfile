# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS build

WORKDIR /workspace

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json cordis.patch.yml README.md LICENSE ./
COPY web ./web
COPY docs ./docs
COPY src ./src
COPY test ./test

RUN npm test \
  && mkdir /out \
  && npm pack --pack-destination /out

FROM scratch AS artifact

COPY --from=build /out/ /
