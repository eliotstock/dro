FROM node:16

# Create app directory
WORKDIR /app

# Install app dependencies
COPY *.json ./
RUN npm install

# Bundle app source
COPY src ./src

# Entrypoint
CMD [ "npm", "run", "dev" ]