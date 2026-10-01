# AIOLists Trakt OAuth Fix

Minimal wrapper around the upstream AIOLists Docker image.

This repository keeps the original AIOLists application intact and patches only
the Trakt OAuth authorization hostname at build time:

- API calls remain on `https://api.trakt.tv`
- OAuth authorization uses `https://trakt.tv/oauth/authorize`

Runtime secrets such as Upstash credentials are configured in the hosting
platform and are not stored in this repository.
