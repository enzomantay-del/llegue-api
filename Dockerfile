FROM dart:stable AS build
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get
COPY . .
RUN dart compile exe bin/server.dart -o /app/server

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/server /app/server
COPY public /app/public
RUN mkdir -p /app/data /app/public
ENV PORT=8787
ENV LLEGUE_DATA=/app/data/store.json
ENV LLEGUE_APK=/app/public/Llegue.apk
EXPOSE 8787
CMD ["/app/server"]
