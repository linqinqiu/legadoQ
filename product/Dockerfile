ARG DOCKER_REGISTRY=""
FROM ${DOCKER_REGISTRY}node:22-alpine AS web-build
WORKDIR /src/web
COPY web/package*.json ./
RUN --mount=type=cache,id=legado-npm-cache,target=/root/.npm \
    if [ -f package-lock.json ]; then \
        npm ci --ignore-scripts --no-audit --fund=false; \
    else \
        npm install --ignore-scripts --no-audit --fund=false; \
    fi
COPY web/ ./
# FeatureGuide.tsx 用 `?raw` 把仓库里的产品说明原文打进页面（说明只有一份，
# 不在前端再抄一遍）。构建上下文是 product/，所以这份 docs/ 要按相对路径放到 /src/docs，
# 少拷贝时 Vite 报 "Could not resolve ../../../docs/功能说明.md?raw"（0.1.8 镜像实测）。
COPY docs/功能说明.md /src/docs/
RUN npm run build

FROM ${DOCKER_REGISTRY}gradle:8.13-jdk17 AS server-build
# 构建镜像必须自带 JDK 17：app/build.gradle 把 toolchain 钉在 17，容器里只有别的版本时
# Gradle 报 "Cannot find a Java installation ... languageVersion=17"（曾用 jdk21 镜像踩过）。
WORKDIR /src
COPY gradle/ gradle/
COPY gradle/libs.versions.toml gradle/libs.versions.toml
# 根三件套必须进容器：settings.gradle（include ':app' + foojay）是构建的根坐标，
# 根 build.gradle 声明 kotlin 插件 alias(apply false)，gradle.properties 带内存与编码配置。
# 少了它们，`gradle -p app` 会把 app/ 当构建根，版本目录（<根>/gradle/）解析不到，
# plugins 块两个 alias 直接编译失败（issue #11，6 秒即死）。
COPY settings.gradle gradle.properties build.gradle ./
COPY app/ app/
COPY --from=web-build /src/web/dist/ app/src/main/resources/static/
# 从仓库根跑任务路径（不再 -p app）：构建根 = /src，settings.gradle 生效。
RUN --mount=type=cache,target=/home/gradle/.gradle gradle :app:clean :app:installDist --no-daemon --no-build-cache \
    && jar uf "$(ls app/build/install/legado/lib/legado-*.jar)" -C app/src/main/resources static

FROM ${DOCKER_REGISTRY}eclipse-temurin:17-jre-jammy
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/* \
    && groupadd --system legado && useradd --system --gid legado legado
WORKDIR /app
COPY --from=server-build /src/app/build/install/legado/ ./
COPY app/docker-entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
# 容器内需绑 0.0.0.0，才能被宿主发布的端口访问；对外的安全边界由部署方
# （如 compose 的 127.0.0.1:8080 映射、反代鉴权、安全组白名单）负责。
# 绑非回环地址必须显式放行，否则服务启动即拒绝（见 http/Guard.kt 的 requireLoopbackBind）——
# 这不是形式主义：它保证"把服务暴露出去"必须是有意识的动作，而不是改一个变量就悄悄发生。
ENV LEGADO_DATA_DIR=/data LEGADO_PORT=8080 LEGADO_HOST=0.0.0.0 LEGADO_ALLOW_EXTERNAL_BIND=1
EXPOSE 8080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["/app/bin/legado"]
