#!/bin/bash

# *** STILL IN DEVELOPMENT AS OF 3/1/2022 ***

# Used for juju scalable deployments.  See here for instructions: https://docs.ubuntu.com/landscape/en/landscape-install-juju
# See here for juju install instructions: https://juju.is/docs/olm/get-started-on-a-localhost

sudo apt-get install juju -y #if this fails, will use snap
snap install juju --classic # Install juju, must use --classic
juju bootstrap localhost # Create new controller, use localhost, not a cloud provider - will take a few minutes, be patient
juju deploy cs:landscape-scalable
#^ After this deploy command finishes, wait _several_ minutes for this to set up.  Check up periodically by typing in 'juju status'.  
# The IP next to juju status haproxy is the IP you'll use to interface with Landscape server on a web browser.  'juju status haproxy' will give you the 
# container with the IP only and no others.
juju status
