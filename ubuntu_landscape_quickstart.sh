#!/bin/bash
# Instructions for Ubuntu Landscape Quickstart deployments are located here: https://docs.ubuntu.com/landscape/en/landscape-install-quickstart


sudo add-apt-repository ppa:landscape/19.10 && sudo apt-get install landscape-server-quickstart

#################
# Prompt for licensing.  (L) for licensed, (F) for free
#
# 
echo "Are you licensing Ubuntu Landscape Server or are you using a free license?"
echo "Licensed (L) - Free (F)"
read licenseResponse

