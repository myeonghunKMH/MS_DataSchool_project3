# 1. Base Image
FROM node:20-alpine

# 2. Set working directory
WORKDIR /usr/src/app

# 3. Copy package files and install dependencies
# Copy package.json and package-lock.json for caching
COPY package*.json ./
# Use 'npm ci' for reproducible builds in CI/CD environments
RUN npm ci --only=production

# 4. Copy application source code
COPY . .

# 5. Expose port
EXPOSE 3000

# 6. Command to run the application
CMD [ "node", "server.js" ]