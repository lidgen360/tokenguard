# -*- mode: ruby -*-
# vi: set ft=ruby :
Vagrant.configure("2") do |config|
  config.vm.box = "gusztavvargadr/windows-10"
  config.vm.box_version = "2202.0.0"
  config.vm.communicator = "winrm"
  config.winrm.username = "vagrant"
  config.winrm.password = "vagrant"
  config.vm.network "private_network", type: "dhcp"
  config.vm.provider "virtualbox" do |vb|
    vb.memory = "4096"
    vb.cpus = 2
  end
  config.vm.synced_folder ".", "/vagrant", type: "smb"
  config.vm.provision "shell", inline: <<-SHELL
    choco install -y nodejs-lts git
    refreshenv
    node --version
    npm --version
  SHELL
  config.vm.provision "shell", privileged: false, inline: <<-SHELL
    cd /vagrant
    npm ci
    npm link
    tokenguard version
    tokenguard autostart print --os win32 --out ./services
    cmd /c services\\tokenguard-schtasks.bat
    schtasks /Query /TN "tokenguard mcpwatch"
  SHELL
end
