FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install base tools
RUN apt-get update && apt-get install -y \
    curl \
    gnupg2 \
    software-properties-common \
    patchelf \
    fakeroot \
    rpm \
    && rm -rf /var/lib/apt/lists/*

# Install PHP 8.4
RUN add-apt-repository ppa:ondrej/php && \
    apt-get update && \
    apt-get install -y \
        php8.4-cli \
        php8.4-mysql \
        php8.4-mbstring \
        php8.4-xml \
        php8.4-curl \
        php8.4-sqlite3 \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 24
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

# Install Electron/AppImage build dependencies
RUN apt-get update && apt-get install -y \
    libgtk-3-0 \
    libnotify-dev \
    libnss3 \
    libxss1 \
    libxtst6 \
    libgconf-2-4 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

CMD ["/bin/bash"]
