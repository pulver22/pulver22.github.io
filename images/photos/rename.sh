index=0;
folder=./sanfrancisco/big/
for name in $folder*.jpg
do
    cp "${name}" "$folder${index}.jpg"
    index=$((index+1))
done
