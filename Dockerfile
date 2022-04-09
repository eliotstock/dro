FROM node:16
LABEL org.opencontainers.image.source="https://github.com/eliotstock/dro"

# Create app directory
WORKDIR /app

# Install base dependencies
RUN npm install \
        ts-node \
        typescript

# Bundle app source
COPY proc ./proc
RUN npm install ./proc

COPY dro ./dro
RUN npm install ./dro

# Volumes
VOLUME /app/dro/out

# Entrypoint
ENTRYPOINT [ "npm", "--prefix", "./proc", "run" ]
CMD [ "proc" ]
