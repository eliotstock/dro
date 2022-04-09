#!/bin/bash
set +ex

#docker run -d --rm -v ${PWD}/.env:/app/dro/.env -v ${PWD}/out:/app/dro/out --name dro dro:latest
docker-compose up --quiet-pull --build --detach
