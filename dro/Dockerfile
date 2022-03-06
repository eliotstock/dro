FROM node:16

# Create app directory
WORKDIR /app

# Install app dependencies
COPY *.json ./
RUN npm install && \
    npm install ts-node

# Bundle app source
COPY src ./src

# Set the user, we don't want this running as root
RUN groupadd -g 999 appuser && \
    useradd -r -u 999 -g appuser appuser
USER appuser

# Entrypoint
ENTRYPOINT [ "npm", "run" ]
CMD [ "prod-console" ]
