FROM node:16
LABEL org.opencontainers.image.source="https://github.com/biketracker/dro"

# Create app directory
WORKDIR /app

# Set the user, we don't want this running as root
RUN groupadd -g 901 dro && \
    useradd -r -u 901 -g dro dro

# Install base dependencies
RUN apt-get update -q && \
    apt-get install -q -y \
        sqlite && \
    npm install \
        ts-node \
        typescript

# Bundle app source
COPY proc ./proc
RUN npm install ./proc

COPY dro ./dro
RUN npm install ./dro

# Entrypoint
USER dro
ENTRYPOINT [ "npm", "--prefix", "./proc", "run" ]
CMD [ "proc" ]
