FROM alpine:3.22 AS tools
WORKDIR /foo
RUN apk add --no-cache wget p7zip unzip

FROM tools AS point-release
RUN wget -q -c https://lvlworld.com/misc-files/Point-Release-1.32-Linux.zip
RUN unzip Point-Release-1.32-Linux.zip
RUN tail -n +356 linuxq3apoint-1.32b-3.x86.run | gzip -d | tar xf -
RUN chmod 644 baseq3/*.pk3

FROM tools AS retail
RUN wget -q -c https://archive.org/download/Quake_III_Arena_Id_Software_1999/Quake_III_Arena_Id_Software_1999.iso
RUN 7z x Quake_III_Arena_Id_Software_1999.iso
RUN chmod 644 Quake3/baseq3/pak0.pk3

FROM tools AS shareware
RUN wget -q -c https://ftp.gwdg.de/pub/misc/ftp.idsoftware.com/idstuff/quake3/linux/linuxq3ademo-1.11-6.x86.gz.sh
RUN tail -n +165 linuxq3ademo-1.11-6.x86.gz.sh | gzip -d | tar xf - demoq3/pak0.pk3
RUN chmod 644 demoq3/pak0.pk3

FROM scratch AS retail-data
COPY --from=retail /foo/Quake3/baseq3/pak0.pk3 /
COPY --from=point-release /foo/baseq3/*.pk3 /

FROM scratch AS shareware-data
COPY --from=shareware /foo/demoq3/pak0.pk3 /
COPY --from=point-release /foo/baseq3/*.pk3 /
