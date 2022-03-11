# Build a Raspberry Pi Ubuntu Server machine to run your DRO

Goals: low power, no fan, secure, simple.

1. Get a Raspberry Pi 400 (keyboard with Raspberry Pi 4 inside) and a monitor.
1. From the host, image the SD card with Ubuntu Server LTS.
1. Unplug the ethernet cable before booting. Goal: this server has never been online before it's been hardened a bit.
1. Boot the target. Wait for cloud-init to run before logging in. Default u & p: `ubuntu`/`ubuntu`.
1. Remember `Ctrl-Alt F1` through `F6` are there for switching to new terminals and multitasking.
1. Add a new user and remove the default `ubuntu` one.
    1. `sudo adduser [username]`.
    1. Add the new user to the `sudo` group:`sudo usermod -aG sudo [username]`
    1. `exit`
    1. Log in using the new user.
    1. `sudo deluser [username]`
1. Change the ssh port from the default
    1. `nano /etc/ssh/sshd_config`
    1. Edit the `Port` line. Pick a random port number and make a note of it.
    1. Restart `sshd`: `sudo service sshd restart`
    1. Make sure there's an `.ssh` directory in your home directory for later: `mkdir -p ~/.ssh`
    1. When connecting from a client, use the `-p [port]` arg for `ssh`
1. Configure the firewall
    1. Config `ufw` is installed: `which ufw`
    1. `sudo ufw default deny incoming`
    1. `sudo ufw default allow outgoing`
    1. `sudo ufw allow [port]/tcp comment 'ssh'`
    1. `sudo ufw enable`
    1. Note that `http` and `https` are absent above.
    1. Check which ports are accessible with `sudo ufw status`
    1. Also block pings: `sudo nano /etc/ufw/before.rules`, find the line reading `A ufw-before-input -p icmp --icmp-type echo-request -j ACCEPT` and change `ACCEPT` to `DROP`
    1. `sudo ufw reload`
1. Change the hostname from the default `ubuntu`. `sudo nano /etc/hostname` and pick a cool hostname.
1. Plug the ethernet cable in and reboot: `sudo reboot`
1. `ifconfig` and note down the IPv4 address. Now you can set your ssh alias.
1. Update packages and get some stuff
    1. `sudo apt update`
    1. `sudo apt upgrade`
    1. `sudo apt install net-tools emacs git`
1. Set up ssh keys for all client machines from which you'll want to connect.
    1. You might like to set an alias in `~/.bashrc` such as `alias <random-name>="ssh -p [port] [username]@[server IP]"`
    1. Similarly for scp: `alias <random-name>="scp -P [port] $1 [username]@[server IP]:/home/[username]"`
    1. `ssh-keygen -t rsa -b 4096 -C "[client nickname]"`
    1. No passphrase.
    1. Accept the default path. You'll get both `~/.ssh/id_rsa.pub` (public key) and `~/.ssh/id_rsa` (private key).
    1. Copy the public key to the server: `scp -P [port] ~/.ssh/id_rsa.pub [username]@[server IP]:/home/[username]/.ssh/authorized_keys`
    1. Verify the file is there on the server.
    1. Verify you can ssh in to the server and you're not prompted for a password. Use the alias you created earlier.
    1. Only allow ssh'ing in using a key from now on. `nano /etc/ssh/sshd_config` and set `PasswordAuthentication no`.
    1. `sudo service sshd restart`
1. Ban any IP address that has multiple failed login attempts using `fail2ban`
    1. `sudo apt install fail2ban`
    1. `sudo cp /etc/fail2ban/fail2ban.conf /etc/fail2ban/fail2ban.local`
    1. `sudo nano /etc/fail2ban/fail2ban.local` and add:
        1. `[sshd]`
        1. `enabled = true`
        1. `port = [port]`
        1. `filter = sshd`
        1. `logpath = /var/log/auth.log`
        1. `maxretry = 3`
        1. `bantime = -1`
    1. `sudo service fail2ban restart`
    1. Check for any banned IPs later with `sudo fail2ban-client status sshd`
1. Configure git user. Cache the personal access token from Github for one week.
    1. `git config --global user.email "foo@example.com"`
    1. `git config --global user.name "Your Name"`
    1. `git config --global credential.helper cache`
    1. `git config --global credential.helper 'cache --timeout=604800'`
    1. From inside a repo: `git config pull.rebase false`
1. Install `nvm`, the Node.js version manager.
    1. Copy the `curl` script from https://github.com/nvm-sh/nvm and execute it.
    1. Exit and restart the terminal to get `nvm` onto the path.
    1. `cd` to this repo and `nvm use` then `nvm install [version]`
    1. `sudo apt install make gcc g++ python sqlite dpkg-dev`
    1. Edit your apt sources list (in the .d directory) to add the source servers.
        1. `sudo cp /etc/apt/sources.list /etc/apt/sources.list.d/foo.list`
        1. `sudo nano /etc/apt/sources.list.d/foo.list`
        1. Uncomment all the sources lines and save
        1. `sudo apt update`
    1. `sudo apt source sqlite`
    1. Follow on above.
1. Switch the display to portrait mode.
    1. Test this works first: `sudo echo 3 | sudo tee /sys/class/graphics/fbcon/rotate_all`
    1. TODO: Consider a sysvinit script or similar. The Raspberry Pi bootloader can't be configured to do this.
