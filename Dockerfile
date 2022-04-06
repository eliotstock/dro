FROM node:16
LABEL org.opencontainers.image.source="https://github.com/biketracker/dro"

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

# Entrypoint
ENTRYPOINT [ "npm", "--prefix", "./proc", "run" ]
CMD [ "proc" ]
