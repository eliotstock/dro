#!/bin/bash
set +ex

docker run -d -v ${PWD}/.env:/app/.env -v ${PWD}/out:/app/out --name dro dro:latest
