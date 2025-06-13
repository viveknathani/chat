# Use a Node.js base image
FROM node:alpine

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and install deps
COPY package*.json ./
RUN npm install

# Copy all files
COPY . .

# Expose desired internal port
EXPOSE 8087

# Start the server
CMD ["npx", "http-server", ".", "-p", "8087"]
