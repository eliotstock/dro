#!/bin/bash
set +ex

docker run -d --rm -v ${PWD}/.env:/app/.env -v ${PWD}/out:/app/out --name dro dro:latest
