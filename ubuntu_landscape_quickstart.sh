#!/bin/bash

# *** SCRIPT DEVELOPMENT STILL IN PROGRESS AS OF MARCH 2, 2022*** *

# Instructions for Ubuntu Landscape Quickstart deployments are located here: https://docs.ubuntu.com/landscape/en/landscape-install-quickstart
# This script is to be run only on supported versions of Ubuntu Landscape Server.  As of the writing of this script (2022-03-01), Ubuntu Landscape Server is supported on 18.04 and lower. 

sudo add-apt-repository ppa:landscape/19.10 && sudo apt-get install landscape-server-quickstart -y

#################
# Prompt for licensing.  (L) for licensed, (F) for free
#
# 
echo "Are you licensing Ubuntu Landscape Server or are you using a free license?"
echo "Licensed (L) - Free (F)"
read licenseResponse # Will need to continue on this for the license file location


#################
# This updates apt-get and installs the landscape-client on the server
sudo apt-get update && sudo apt-get install landscape-client -y
