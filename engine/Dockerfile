# ioquake3 source and the complete compiler/runtime versions are pinned. The
# archive hash makes a changed or substituted source download fail the build.
ARG EMSDK_IMAGE=emscripten/emsdk:6.0.9@sha256:96617f27fe16421588241def73908fd348a7f9d260440ed0d00b36dcf7a063cc
ARG DEBIAN_IMAGE=debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG IOQ3_COMMIT=83a776283bdb958f82db25554b5ed0966aaf6e49
ARG IOQ3_SHA256=cff55a0128ddca72aa7ce1dda89c0c946a84324a4472a3a7805d3a4d3c3cf8e4

FROM ${DEBIAN_IMAGE} AS source
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates curl patch \
    && rm -rf /var/lib/apt/lists/*
ARG IOQ3_COMMIT
ARG IOQ3_SHA256
COPY engine/patches/ /tmp/patches/
RUN curl --fail --location --silent --show-error \
      "https://github.com/ioquake/ioq3/archive/${IOQ3_COMMIT}.tar.gz" \
      --output /tmp/ioq3.tar.gz \
    && echo "${IOQ3_SHA256}  /tmp/ioq3.tar.gz" | sha256sum --check \
    && mkdir -p /opt/ioq3-source \
    && tar --extract --gzip --file /tmp/ioq3.tar.gz --directory /opt/ioq3-source --strip-components=1 \
    && patch --directory=/opt/ioq3-source --strip=1 < /tmp/patches/ioq3-web-policy.diff \
    && patch --directory=/opt/ioq3-source --strip=1 < /tmp/patches/ioq3-server-runtime.diff \
    && rm -rf /tmp/ioq3.tar.gz /tmp/patches

FROM ${EMSDK_IMAGE} AS web-builder
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ninja-build \
    && rm -rf /var/lib/apt/lists/*
COPY --from=source /opt/ioq3-source /src
ENV SOURCE_DATE_EPOCH=1789667953
RUN emcmake cmake -S /src -B /build -G Ninja \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_CLIENT=ON \
      -DBUILD_SERVER=OFF \
      -DBUILD_GAME_LIBRARIES=OFF \
      -DBUILD_GAME_QVMS=OFF \
      -DBUILD_RENDERER_GL1=OFF \
      -DBUILD_RENDERER_GL2=ON \
      -DUSE_RENDERER_DLOPEN=OFF \
      -DUSE_OPENAL=OFF \
      -DUSE_VOIP=OFF \
      -DUSE_MUMBLE=OFF \
    && cmake --build /build --parallel

FROM ${DEBIAN_IMAGE} AS native-builder
RUN apt-get update \
    && apt-get install --yes --no-install-recommends build-essential cmake ninja-build musl-tools \
    && rm -rf /var/lib/apt/lists/*
COPY --from=source /opt/ioq3-source /src
ENV SOURCE_DATE_EPOCH=1789667953
RUN cmake -S /src -B /build -G Ninja \
      -DCMAKE_C_COMPILER=musl-gcc \
      -DCMAKE_EXE_LINKER_FLAGS=-static \
      -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_CLIENT=OFF \
      -DBUILD_SERVER=ON \
      -DBUILD_GAME_LIBRARIES=OFF \
      -DBUILD_GAME_QVMS=ON \
      -DBUILD_RENDERER_GL1=OFF \
      -DBUILD_RENDERER_GL2=OFF \
      -DUSE_OPENAL=OFF \
      -DUSE_VOIP=OFF \
      -DUSE_MUMBLE=OFF \
    && cmake --build /build --parallel

# Fail the build if the dedicated server ever gains a dynamic dependency.
RUN readelf --program-headers /build/Release/ioq3ded > /tmp/program-headers \
    && readelf --dynamic /build/Release/ioq3ded > /tmp/dynamic \
    && ! grep -q INTERP /tmp/program-headers \
    && ! grep -q NEEDED /tmp/dynamic \
    && /build/Release/ioq3ded --version

# Prepare a minimal static-server filesystem in the build stage.
RUN mkdir -p /runtime/app/baseq3/vm /runtime/config/baseq3 /runtime/data/baseq3 /runtime/state \
    && install -m 755 /build/Release/ioq3ded /runtime/app/ioq3ded \
    && install -m 755 /build/Release/baseq3/vm/qagame.qvm /runtime/app/baseq3/vm/qagame.qvm
COPY engine/server.cfg /runtime/config/baseq3/server.cfg
RUN chmod -R 755 /runtime

FROM scratch AS game-server
COPY --from=native-builder /runtime/ /
WORKDIR /app
EXPOSE 27961/udp
ENTRYPOINT ["/app/ioq3ded", "+set", "dedicated", "1", "+set", "fs_basepath", "/data", "+set", "fs_assetpath", "/app", "+set", "fs_configpath", "/config", "+set", "fs_homepath", "/state", "+set", "net_enabled", "11", "+set", "net_ip", "127.0.0.1", "+set", "net_ip6", "::1", "+set", "net_port", "27961", "+set", "net_port6", "27961"]
CMD ["+exec", "server.cfg"]

FROM ${DEBIAN_IMAGE} AS web-client
RUN apt-get update \
    && apt-get install --yes --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/web /app/qvm/baseq3 /data/baseq3
WORKDIR /app
COPY --from=native-builder /build/Release/baseq3/vm/cgame.qvm /build/Release/baseq3/vm/ui.qvm ./qvm/baseq3/
COPY --from=web-builder /build/Release/ioquake3.js /build/Release/ioquake3.wasm ./web/
COPY web/index.html web/client-config.json web/reconnect.js ./web/
COPY web/nginx.conf /etc/nginx/nginx.conf
RUN chmod -R 755 /app && chmod 755 /etc/nginx/nginx.conf
VOLUME ["/data"]
EXPOSE 8080/tcp
ENTRYPOINT ["nginx", "-g", "daemon off;"]
