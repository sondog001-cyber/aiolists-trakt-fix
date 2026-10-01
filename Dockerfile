FROM ghcr.io/sebastianmorel/aiolists:latest

RUN sed -i \
  "s#const TRAKT_API_URL = 'https://api.trakt.tv';#const TRAKT_API_URL = 'https://api.trakt.tv';\\nconst TRAKT_AUTH_URL = 'https://trakt.tv';#" \
  /usr/src/app/src/integrations/trakt.js \
  && sed -i \
  's#`${TRAKT_API_URL}/oauth/authorize#`${TRAKT_AUTH_URL}/oauth/authorize#' \
  /usr/src/app/src/integrations/trakt.js

ENV PORT=7000
