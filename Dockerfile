FROM ghcr.io/sebastianmorel/aiolists:latest

COPY patch.js /tmp/patch.js
RUN node /tmp/patch.js && rm /tmp/patch.js

ENV PORT=7000
