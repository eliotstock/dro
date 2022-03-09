FROM node:16

# Create app directory
WORKDIR /app

# Install app dependencies
COPY *.json ./
RUN apt update && \
    apt install -y sqlite && \
    npm install && \
    npm install ts-node

# Bundle app source
COPY src ./src

# Set the user, we don't want this running as root
RUN groupadd -g 901 dro && \
    useradd -r -u 901 -g dro dro
USER dro

# Entrypoint
ENTRYPOINT [ "npm", "run" ]
CMD [ "prod-console" ]
