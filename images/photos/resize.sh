folder=./paris/big
out=$folder/small
mkdir out
find $folder -maxdepth 1 -iname "*.jpg" | xargs -L1 -I{} convert -resize 250 "{}" $out/"{}"
