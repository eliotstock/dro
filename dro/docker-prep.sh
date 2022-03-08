#!/bin/bash
set +ex

GID=901

if [ "$EUID" -ne 0 ]
  then echo "Please run as root"
  exit
fi

mkdir -p out
chgrp $GID out/
chmod 775 out/
chmod g+s out/
