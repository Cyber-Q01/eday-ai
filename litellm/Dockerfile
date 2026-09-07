# LiteLLM proxy — self-hosted (free, MIT). See config.yaml for model routing.
FROM ghcr.io/berriai/litellm:main-stable
WORKDIR /app
COPY config.yaml ./config.yaml
ENV LITELLM_MASTER_KEY=sk-litellm-local
EXPOSE 4000
CMD ["--config", "/app/config.yaml", "--port", "4000"]
