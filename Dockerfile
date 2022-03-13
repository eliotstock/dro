FROM node:16

# Create app directory
WORKDIR /app

# Set the user, we don't want this running as root
RUN groupadd -g 901 dro && \
    useradd -r -u 901 -g dro dro

# Install base dependencies
RUN apt update && \
    apt install -y \
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
